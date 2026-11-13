import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	INodePropertyOptions,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

// Altijd met www: zonder www volgt een redirect die POST-verzoeken breekt.
export const BASIS_URL = 'https://www.briefverzenden.nl/api/v1';

export const PORTAAL_URL = 'https://www.briefverzenden.nl/zakelijk/portal';

export const STATUSSEN: INodePropertyOptions[] = [
	{ name: 'Cancelled', value: 'geannuleerd', description: 'API value: geannuleerd' },
	{ name: 'Delivered', value: 'bezorgd', description: 'API value: bezorgd' },
	{
		name: 'Failed (Amount Refunded)',
		value: 'mislukt',
		description: 'API value: mislukt. The amount has been refunded to the credit balance.',
	},
	{ name: 'Sent', value: 'verzonden', description: 'API value: verzonden' },
	{ name: 'Submitted', value: 'ingediend', description: 'API value: ingediend' },
	{ name: 'Undeliverable', value: 'onbestelbaar', description: 'API value: onbestelbaar' },
];

/**
 * De API geeft foutmeldingen in het Nederlands. Voor de (Engelstalige) n8n-interface tonen we
 * per bekende foutcode een Engelse melding; de originele tekst van de API komt in de beschrijving.
 */
const ENGELSE_FOUTEN: Record<string, string> = {
	aangetekend_niet_beschikbaar: 'Registered mail is not available for this country',
	afzender_te_lang: 'The sender line is too long to fit on one line',
	configuratie: 'BriefVerzenden.nl reported a server configuration error',
	geen_sleutel: 'No API key was sent',
	indienen_mislukt: 'The letter could not be submitted to the carrier',
	land_onbekend: 'BriefVerzenden.nl does not deliver to this country',
	niet_gevonden: 'This letter does not exist in this account',
	niet_leverbaar: 'This letter cannot be sent with the chosen options',
	ongeldige_idempotency_key: 'Invalid idempotency key',
	ongeldige_invoer: 'Invalid input',
	ongeldige_sleutel: 'The API key is invalid or has been revoked',
	onvoldoende_tegoed: 'Insufficient credit balance',
	opslag: 'The letter could not be saved; nothing was charged',
	pdf_dubbel: 'Send either a PDF file or a PDF URL, not both',
	pdf_ongeldig: 'The PDF could not be used',
	pdf_ontbreekt: 'No PDF was provided',
	prijs_mislukt: 'The price could not be calculated',
	serverfout: 'Something went wrong at BriefVerzenden.nl',
	snelheid_ongeldig: 'This shipping speed is not available for this country',
};

const ENGELSE_HTTP_FOUTEN: Record<number, string> = {
	400: 'BriefVerzenden.nl rejected the request',
	401: 'The API key is missing or invalid',
	402: 'Insufficient credit balance',
	404: 'Not found',
	429: 'Too many requests',
};

type Context = IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions;

export interface ApiAntwoord {
	body: IDataObject;
	headers: Record<string, unknown>;
	statusCode: number;
}

interface VerzoekOpties {
	body?: IDataObject;
	qs?: IDataObject;
	headers?: Record<string, string>;
	itemIndex?: number;
	/** Voor /landen: daar is geen sleutel voor nodig (handig in loadOptions zonder credential). */
	zonderSleutel?: boolean;
}

function kopWaarde(headers: Record<string, unknown>, naam: string): string | undefined {
	const gevonden = Object.keys(headers).find((k) => k.toLowerCase() === naam.toLowerCase());
	if (!gevonden) return undefined;
	const waarde = headers[gevonden];
	return Array.isArray(waarde)
		? String(waarde[0])
		: waarde === undefined
			? undefined
			: String(waarde);
}

/**
 * Eén verzoek naar de BriefVerzenden.nl API. Fouten van de API (`{ error, code }`) worden
 * omgezet in een NodeApiError met een Engelse melding; de Nederlandse uitleg van de API staat in de beschrijving.
 */
export async function briefverzendenVerzoekVolledig(
	this: Context,
	method: IHttpRequestMethods,
	pad: string,
	opties: VerzoekOpties = {},
): Promise<ApiAntwoord> {
	const verzoek: IHttpRequestOptions = {
		method,
		url: `${BASIS_URL}${pad}`,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		headers: { Accept: 'application/json', ...(opties.headers ?? {}) },
	};
	if (opties.body !== undefined) verzoek.body = opties.body;
	if (opties.qs !== undefined) verzoek.qs = opties.qs;

	let antwoord: IN8nHttpFullResponse;
	try {
		if (opties.zonderSleutel) {
			verzoek.headers = { ...verzoek.headers, 'X-Bron': 'n8n' };
			antwoord = (await this.helpers.httpRequest(verzoek)) as IN8nHttpFullResponse;
		} else {
			antwoord = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				'briefverzendenApi',
				verzoek,
			)) as IN8nHttpFullResponse;
		}
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject, {
			message: 'Could not reach BriefVerzenden.nl',
			description: 'Check the internet connection of your n8n instance and try again later.',
			itemIndex: opties.itemIndex,
		});
	}

	const headers = (antwoord.headers ?? {}) as Record<string, unknown>;
	const statusCode = antwoord.statusCode;
	const body =
		antwoord.body !== null && typeof antwoord.body === 'object' && !Array.isArray(antwoord.body)
			? (antwoord.body as IDataObject)
			: {};

	if (statusCode >= 400) {
		const apiTekst = typeof body.error === 'string' && body.error ? body.error : '';
		const code = typeof body.code === 'string' ? body.code : undefined;
		const melding =
			(code && ENGELSE_FOUTEN[code]) ||
			ENGELSE_HTTP_FOUTEN[statusCode] ||
			`BriefVerzenden.nl returned an error (HTTP ${statusCode})`;
		const uitleg: string[] = [];
		if (statusCode === 401) {
			uitleg.push(
				`Check the API key in the credential. You can manage keys at ${PORTAAL_URL}#api.`,
			);
		}
		if (statusCode === 402) {
			uitleg.push(`Nothing was sent. Top up your credit balance in the portal: ${PORTAAL_URL}.`);
		}
		if (statusCode === 429) {
			const wacht = kopWaarde(headers, 'retry-after');
			uitleg.push(
				wacht
					? `Too many requests. Try again in ${wacht} seconds.`
					: 'Too many requests. Try again shortly.',
			);
		}
		if (statusCode === 502 && code === 'indienen_mislukt') {
			uitleg.push('The amount has been refunded to your credit balance.');
		}
		if (statusCode >= 500 && code !== 'indienen_mislukt') {
			uitleg.push(
				'Try again. When sending with the same idempotency key, the letter is never sent twice.',
			);
		}
		if (apiTekst) uitleg.push(`Details from the API (in Dutch): "${apiTekst}".`);
		if (code) uitleg.push(`Error code: ${code}.`);
		throw new NodeApiError(
			this.getNode(),
			{ ...body, httpCode: String(statusCode) } as JsonObject,
			{
				message: melding,
				description: uitleg.length ? uitleg.join(' ') : undefined,
				httpCode: String(statusCode),
				itemIndex: opties.itemIndex,
			},
		);
	}

	return { body, headers, statusCode };
}

export async function briefverzendenVerzoek(
	this: Context,
	method: IHttpRequestMethods,
	pad: string,
	opties: VerzoekOpties = {},
): Promise<IDataObject> {
	const { body } = await briefverzendenVerzoekVolledig.call(this, method, pad, opties);
	return body;
}

export function isIdempotentHerhaald(headers: Record<string, unknown>): boolean {
	return kopWaarde(headers, 'idempotent-replayed') === 'true';
}
