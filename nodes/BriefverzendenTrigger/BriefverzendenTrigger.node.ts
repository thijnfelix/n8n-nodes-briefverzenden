import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { briefverzendenVerzoek, STATUSSEN } from '../Briefverzenden/GenericFunctions';

// De API geeft hooguit 100 brieven per keer, nieuwste eerst. Oudere brieven vallen buiten
// het zicht van de trigger.
const VENSTER = 100;

interface Staat {
	statussen?: Record<string, string>;
}

export class BriefverzendenTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'BriefVerzenden.nl Trigger',
		name: 'briefverzendenTrigger',
		icon: { light: 'file:briefverzenden.svg', dark: 'file:briefverzenden.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: 'On letter status change',
		description: 'Starts the workflow when the status of a letter changes',
		defaults: {
			name: 'BriefVerzenden.nl Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'briefverzendenApi',
				required: true,
			},
		],
		properties: [
			{
				displayName:
					'On every poll, this trigger checks the 100 most recent letters and outputs the letters whose status changed since the previous poll. The first poll after activation only records the current statuses.',
				name: 'uitleg',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Statuses',
				name: 'statussen',
				type: 'multiOptions',
				options: STATUSSEN,
				default: [],
				description:
					'Only trigger when a letter changes to one of these statuses. Leave empty to trigger on every change.',
			},
			{
				displayName: 'Include New Letters',
				name: 'nieuweBrieven',
				type: 'boolean',
				default: true,
				description:
					'Whether to also trigger for letters created since the previous poll (their first status counts as a change)',
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const staat = this.getWorkflowStaticData('node') as Staat;
		const filter = this.getNodeParameter('statussen', []) as string[];
		const nieuweBrieven = this.getNodeParameter('nieuweBrieven', true) as boolean;
		const handmatig = this.getMode() === 'manual';

		const antwoord = await briefverzendenVerzoek.call(this, 'GET', '/brieven', {
			qs: { limit: VENSTER },
		});
		const brieven = (
			Array.isArray(antwoord.brieven) ? (antwoord.brieven as IDataObject[]) : []
		).filter((b) => typeof b.id === 'string' && typeof b.status === 'string');
		const pastInFilter = (b: IDataObject) =>
			filter.length === 0 || filter.includes(b.status as string);

		// Handmatig testen: laat de nieuwste passende brief zien, raak de opgeslagen stand niet aan.
		if (handmatig) {
			const voorbeeld = brieven.find(pastInFilter);
			return voorbeeld
				? [this.helpers.returnJsonArray([{ ...voorbeeld, vorigeStatus: null }])]
				: null;
		}

		const huidige: Record<string, string> = {};
		for (const b of brieven) huidige[b.id as string] = b.status as string;

		const vorige = staat.statussen;
		staat.statussen = huidige;

		// Eerste keer: alleen de stand vastleggen, niets afvuren.
		if (!vorige) return null;

		const gewijzigd = brieven.filter((b) => {
			const was = vorige[b.id as string];
			if (was === undefined && !nieuweBrieven) return false;
			return was !== b.status && pastInFilter(b);
		});
		if (gewijzigd.length === 0) return null;

		// Oudste eerst, zodat de workflow de wijzigingen in volgorde verwerkt.
		const uit = gewijzigd
			.reverse()
			.map((b) => ({ ...b, vorigeStatus: vorige[b.id as string] ?? null }));
		return [this.helpers.returnJsonArray(uit)];
	}
}
