import { createHash } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	JsonObject,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	briefverzendenVerzoek,
	briefverzendenVerzoekVolledig,
	isIdempotentHerhaald,
	STATUSSEN,
} from './GenericFunctions';

// pdfBase64 mag hooguit ±3 MB zijn: base64 maakt het een derde groter en de API heeft een
// request-limiet van 4,5 MB.
const MAX_PDF_BYTES = 3 * 1024 * 1024;

const IDEMPOTENCY_PATROON = /^[A-Za-z0-9_.:-]{8,200}$/;

const SNELHEDEN: INodePropertyOptions[] = [
	{ name: 'Economy', value: 'traag', description: 'Slowest and cheapest (API value: traag)' },
	{ name: 'Fast', value: 'snel', description: 'API value: snel' },
	{
		name: 'Plus (Tracked)',
		value: 'plus',
		description: 'Swiss Post A-Post Plus: tracking number, no signature (API value: plus)',
	},
	{ name: 'Standard', value: 'standaard', description: 'API value: standaard' },
];

const SNELHEID_LABELS: Record<string, string> = {
	plus: 'plus (tracked)',
	snel: 'fast',
	standaard: 'standard',
	traag: 'economy',
};

const toonBij = (resource: string, operation: string[]) => ({
	show: { resource: [resource], operation },
});

/** Engelse landnaam bij een ISO-2-code; valt terug op de (Nederlandse) naam uit de API. */
function engelseLandnaam(code: string, fallback: string): string {
	try {
		const naam = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
		return naam && naam !== code ? naam : fallback;
	} catch {
		return fallback;
	}
}

export class Briefverzenden implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'BriefVerzenden.nl',
		name: 'briefverzenden',
		icon: { light: 'file:briefverzenden.svg', dark: 'file:briefverzenden.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle:
			'={{ $parameter["operation"] === "versturen" ? "Send letter" : $parameter["operation"] === "ophalen" ? "Get letter" : $parameter["operation"] === "lijst" ? "Get many letters" : $parameter["operation"] === "prijs" ? "Calculate price" : $parameter["operation"] === "tegoed" ? "Get balance" : $parameter["operation"] }}',
		description: 'Send real postal letters from a PDF with BriefVerzenden.nl',
		defaults: {
			name: 'BriefVerzenden.nl',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'briefverzendenApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'Letter', value: 'brief' },
				],
				default: 'brief',
			},

			// ── Operaties ──────────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['brief'] } },
				options: [
					{
						name: 'Calculate Price',
						value: 'prijs',
						description: 'Calculate what a letter costs, without sending anything',
						action: 'Calculate the price of a letter',
					},
					{
						name: 'Get',
						value: 'ophalen',
						description: 'Get a letter with its current status',
						action: 'Get a letter',
					},
					{
						name: 'Get Many',
						value: 'lijst',
						description: 'Get recent letters, newest first',
						action: 'Get many letters',
					},
					{
						name: 'Send',
						value: 'versturen',
						description: 'Send a PDF as a real letter (charged to your credit balance)',
						action: 'Send a letter',
					},
				],
				default: 'versturen',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{
						name: 'Get Balance',
						value: 'tegoed',
						description: 'Get account details and the current credit balance',
						action: 'Get the account balance',
					},
				],
				default: 'tegoed',
			},

			// ── Brief: Versturen ───────────────────────────────────────────────────
			{
				displayName: 'Recipient Name',
				name: 'naam',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'Acme Ltd',
				description: 'Person or company name on the envelope (max. 120 characters).',
				displayOptions: toonBij('brief', ['versturen']),
			},
			{
				displayName: 'Attention Line',
				name: 'tav',
				type: 'string',
				default: '',
				placeholder: 'Accounts Payable',
				description:
					'Optional "Attn." line, for example a department or person (max. 120 characters).',
				displayOptions: toonBij('brief', ['versturen']),
			},
			{
				displayName: 'Street Address',
				name: 'adres',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'Keizersgracht 1',
				description: 'Street name and house number (max. 120 characters).',
				displayOptions: toonBij('brief', ['versturen']),
			},
			{
				displayName: 'Postal Code',
				name: 'postcode',
				type: 'string',
				required: true,
				default: '',
				placeholder: '1015 AA',
				displayOptions: toonBij('brief', ['versturen']),
			},
			{
				displayName: 'City',
				name: 'woonplaats',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'Amsterdam',
				displayOptions: toonBij('brief', ['versturen']),
			},
			{
				displayName: 'Country Name or ID',
				name: 'land',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getLanden' },
				default: 'NL',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				hint: 'Country of the recipient. In an expression, use the two-letter ISO country code, for example DE.',
				displayOptions: toonBij('brief', ['versturen', 'prijs']),
			},
			{
				displayName: 'PDF Source',
				name: 'pdfBron',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Binary Field',
						value: 'binair',
						description: 'A PDF from a previous step (max. 3 MB).',
					},
					{
						name: 'URL',
						value: 'url',
						description: 'BriefVerzenden.nl downloads the PDF itself (HTTPS, max. 10 MB).',
					},
				],
				default: 'binair',
				description:
					'Where the PDF comes from. The address does not need to be in the PDF: a cover page with the address in the envelope window is added in front.',
				displayOptions: toonBij('brief', ['versturen']),
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				description: 'Name of the binary field that contains the PDF (A4, max. 60 pages).',
				displayOptions: {
					show: { resource: ['brief'], operation: ['versturen'], pdfBron: ['binair'] },
				},
			},
			{
				displayName: 'PDF URL',
				name: 'pdfUrl',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://example.com/invoice.pdf',
				description: 'Public HTTPS URL of the PDF (port 443, max. 3 redirects).',
				displayOptions: {
					show: { resource: ['brief'], operation: ['versturen'], pdfBron: ['url'] },
				},
			},
			{
				displayName: 'Options',
				name: 'opties',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: toonBij('brief', ['versturen']),
				options: [
					{
						displayName: 'Color',
						name: 'kleur',
						type: 'boolean',
						default: false,
						description: 'Whether to print in color instead of black and white',
					},
					{
						displayName: 'Double-Sided',
						name: 'dubbelzijdig',
						type: 'boolean',
						default: true,
						description: 'Whether to print on both sides of the paper',
					},
					{
						displayName: 'Idempotency Key',
						name: 'idempotencyKey',
						type: 'string',
						default: '',
						description:
							'Your own key (8–200 characters: letters, digits and _ . : -). The same key returns the same letter and sends nothing again. If empty, the node derives a key from the execution and the item, so a retry within the same execution never sends twice.',
					},
					{
						displayName: 'Reference',
						name: 'referentie',
						type: 'string',
						default: '',
						description: 'Your own reference (max. 100 characters), returned unchanged.',
					},
					{
						displayName: 'Registered Mail',
						name: 'aangetekend',
						type: 'boolean',
						default: false,
						description: 'Whether to send the letter as registered mail',
						hint: 'Not available for every country; see the country list',
					},
					{
						displayName: 'Sender Line',
						name: 'afzender',
						type: 'string',
						default: '',
						description: 'One line of sender text on the address cover page (max. 200 characters).',
					},
					{
						displayName: 'Shipping Speed',
						name: 'snelheid',
						type: 'options',
						options: SNELHEDEN,
						default: 'standaard',
						description: 'Which speeds are available depends on the country',
					},
				],
			},

			// ── Brief: Ophalen ─────────────────────────────────────────────────────
			{
				displayName: 'Letter ID',
				name: 'briefId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'brf_0123456789abcdef01234567',
				displayOptions: toonBij('brief', ['ophalen']),
			},

			// ── Brief: Lijst ───────────────────────────────────────────────────────
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: toonBij('brief', ['lijst']),
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: [{ name: 'All Statuses', value: '' }, ...STATUSSEN],
				default: '',
				description: 'Only return letters with this status',
				displayOptions: toonBij('brief', ['lijst']),
			},

			// ── Brief: Prijs berekenen ─────────────────────────────────────────────
			{
				displayName: 'Pages',
				name: 'paginas',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 60 },
				default: 1,
				description: 'Number of pages in the PDF (the address cover page is not counted)',
				displayOptions: toonBij('brief', ['prijs']),
			},
			{
				displayName: 'Options',
				name: 'prijsOpties',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: toonBij('brief', ['prijs']),
				options: [
					{
						displayName: 'Color',
						name: 'kleur',
						type: 'boolean',
						default: false,
						description: 'Whether to print in color instead of black and white',
					},
					{
						displayName: 'Double-Sided',
						name: 'dubbelzijdig',
						type: 'boolean',
						default: true,
						description: 'Whether to print on both sides of the paper',
					},
					{
						displayName: 'Registered Mail',
						name: 'aangetekend',
						type: 'boolean',
						default: false,
						description: 'Whether to send the letter as registered mail',
					},
					{
						displayName: 'Shipping Speed',
						name: 'snelheid',
						type: 'options',
						options: SNELHEDEN,
						default: 'standaard',
						description: 'Which speeds are available depends on the country',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getLanden(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const antwoord = await briefverzendenVerzoek.call(this, 'GET', '/landen', {
					zonderSleutel: true,
				});
				const landen = Array.isArray(antwoord.landen) ? (antwoord.landen as IDataObject[]) : [];
				return landen
					.filter((l) => typeof l.code === 'string')
					.map((l) => {
						const code = String(l.code);
						const snelheden = Array.isArray(l.snelheden)
							? (l.snelheden as string[]).map((s) => SNELHEID_LABELS[s] ?? s)
							: undefined;
						return {
							name: `${engelseLandnaam(code, String(l.naam ?? code))} (${code})`,
							value: code,
							description: snelheden
								? `Speeds: ${snelheden.join(', ')}${l.aangetekend ? ' · registered mail available' : ''}`
								: undefined,
						};
					})
					.sort((a, b) => a.name.localeCompare(b.name, 'en'));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resultaat: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'account' && operation === 'tegoed') {
					const me = await briefverzendenVerzoek.call(this, 'GET', '/me', { itemIndex: i });
					resultaat.push({ json: me, pairedItem: { item: i } });
					continue;
				}

				if (resource !== 'brief') {
					throw new NodeOperationError(this.getNode(), `Unknown resource: ${resource}`, {
						itemIndex: i,
					});
				}

				if (operation === 'versturen') {
					resultaat.push(await verstuurBrief.call(this, i));
				} else if (operation === 'ophalen') {
					const id = (this.getNodeParameter('briefId', i) as string).trim();
					if (!id) {
						throw new NodeOperationError(this.getNode(), 'Enter a letter ID', { itemIndex: i });
					}
					const brief = await briefverzendenVerzoek.call(
						this,
						'GET',
						`/brieven/${encodeURIComponent(id)}`,
						{ itemIndex: i },
					);
					resultaat.push({ json: brief, pairedItem: { item: i } });
				} else if (operation === 'lijst') {
					const limit = this.getNodeParameter('limit', i) as number;
					const status = this.getNodeParameter('status', i, '') as string;
					const qs: IDataObject = { limit };
					if (status) qs.status = status;
					const antwoord = await briefverzendenVerzoek.call(this, 'GET', '/brieven', {
						qs,
						itemIndex: i,
					});
					const brieven = Array.isArray(antwoord.brieven)
						? (antwoord.brieven as IDataObject[])
						: [];
					for (const brief of brieven) resultaat.push({ json: brief, pairedItem: { item: i } });
				} else if (operation === 'prijs') {
					const opties = this.getNodeParameter('prijsOpties', i, {}) as IDataObject;
					const body: IDataObject = {
						ontvanger: { land: this.getNodeParameter('land', i) as string },
						paginas: this.getNodeParameter('paginas', i) as number,
						...opties,
					};
					const prijs = await briefverzendenVerzoek.call(this, 'POST', '/prijs', {
						body,
						itemIndex: i,
					});
					resultaat.push({ json: prijs, pairedItem: { item: i } });
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
						itemIndex: i,
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					const fout: IDataObject = { error: (error as Error).message };
					if (error instanceof NodeApiError) {
						if (error.description) fout.description = error.description;
						if (error.httpCode) fout.httpCode = error.httpCode;
					}
					resultaat.push({ json: fout, pairedItem: { item: i } });
					continue;
				}
				// Een NodeApiError komt ongewijzigd terug; de rest wordt een NodeOperationError.
				if (error instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject);
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [resultaat];
	}
}

async function verstuurBrief(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const tekst = (naam: string) => (this.getNodeParameter(naam, i, '') as string).trim();

	const ontvanger: IDataObject = {
		naam: tekst('naam'),
		adres: tekst('adres'),
		postcode: tekst('postcode'),
		woonplaats: tekst('woonplaats'),
		land: tekst('land') || 'NL',
	};
	const tav = tekst('tav');
	if (tav) ontvanger.tav = tav;

	const opties = this.getNodeParameter('opties', i, {}) as IDataObject;
	const body: IDataObject = { ontvanger };
	for (const sleutel of ['kleur', 'dubbelzijdig', 'aangetekend'] as const) {
		if (typeof opties[sleutel] === 'boolean') body[sleutel] = opties[sleutel];
	}
	for (const sleutel of ['snelheid', 'afzender', 'referentie'] as const) {
		const waarde = typeof opties[sleutel] === 'string' ? (opties[sleutel] as string).trim() : '';
		if (waarde) body[sleutel] = waarde;
	}

	// PDF + vingerafdruk van de inhoud (voor de afgeleide Idempotency-Key).
	const pdfBron = this.getNodeParameter('pdfBron', i) as string;
	let pdfVingerafdruk: string;
	if (pdfBron === 'url') {
		const pdfUrl = tekst('pdfUrl');
		if (!/^https:\/\//i.test(pdfUrl)) {
			throw new NodeOperationError(this.getNode(), 'The PDF URL must start with https://', {
				itemIndex: i,
			});
		}
		body.pdfUrl = pdfUrl;
		pdfVingerafdruk = `url:${pdfUrl}`;
	} else {
		const veld = tekst('binaryPropertyName') || 'data';
		this.helpers.assertBinaryData(i, veld);
		const buffer = await this.helpers.getBinaryDataBuffer(i, veld);
		if (buffer.length > MAX_PDF_BYTES) {
			const mb = (buffer.length / 1024 / 1024).toFixed(1);
			throw new NodeOperationError(
				this.getNode(),
				`The PDF is too large to upload (${mb} MB, max. 3 MB)`,
				{
					itemIndex: i,
					description:
						'Set "PDF Source" to "URL" and provide a public HTTPS link to the PDF. Via a URL the PDF can be up to 10 MB.',
				},
			);
		}
		if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
			throw new NodeOperationError(
				this.getNode(),
				`The binary field "${veld}" does not contain a PDF`,
				{ itemIndex: i, description: 'BriefVerzenden.nl only sends PDF files (A4).' },
			);
		}
		body.pdfBase64 = buffer.toString('base64');
		pdfVingerafdruk = `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
	}

	let idempotencyKey =
		typeof opties.idempotencyKey === 'string' ? opties.idempotencyKey.trim() : '';
	if (idempotencyKey) {
		if (!IDEMPOTENCY_PATROON.test(idempotencyKey)) {
			throw new NodeOperationError(this.getNode(), 'Invalid idempotency key', {
				itemIndex: i,
				description: 'Use 8–200 characters: letters, digits and _ . : -',
			});
		}
	} else {
		idempotencyKey = afgeleideSleutel.call(this, i, body, pdfVingerafdruk);
	}

	const headers: Record<string, string> = {};
	if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

	const antwoord = await briefverzendenVerzoekVolledig.call(this, 'POST', '/brieven', {
		body,
		headers,
		itemIndex: i,
	});

	return {
		json: { ...antwoord.body, idempotentHerhaald: isIdempotentHerhaald(antwoord.headers) },
		pairedItem: { item: i },
	};
}

/**
 * Deterministische Idempotency-Key: dezelfde n8n-installatie, workflow, node, uitvoering, item
 * en inhoud geven dezelfde sleutel. Een herhaalde poging binnen dezelfde uitvoering
 * ("Retry On Fail") verstuurt zo niets dubbel. De inhoud zit erin zodat een node die in een
 * lus meerdere keren met item 0 draait niet per ongeluk de eerste brief terugkrijgt.
 */
function afgeleideSleutel(
	this: IExecuteFunctions,
	i: number,
	body: IDataObject,
	pdfVingerafdruk: string,
): string {
	const uitvoering = this.getExecutionId();
	if (!uitvoering) return '';
	const zonderPdf: IDataObject = { ...body };
	delete zonderPdf.pdfBase64;
	const bron = JSON.stringify([
		this.getInstanceId(),
		this.getWorkflow().id ?? '',
		this.getNode().name,
		uitvoering,
		i,
		zonderPdf,
		pdfVingerafdruk,
	]);
	return `n8n-${createHash('sha256').update(bron).digest('hex').slice(0, 48)}`;
}
