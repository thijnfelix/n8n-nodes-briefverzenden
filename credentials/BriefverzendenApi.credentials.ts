import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class BriefverzendenApi implements ICredentialType {
	name = 'briefverzendenApi';

	displayName = 'BriefVerzenden.nl API';

	icon: Icon = { light: 'file:briefverzenden.svg', dark: 'file:briefverzenden.dark.svg' };

	documentationUrl = 'https://www.briefverzenden.nl/zakelijk/api';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'bv_live_…',
			description:
				'Your API key (starts with bv_live_). Create one in the <a href="https://www.briefverzenden.nl/zakelijk/portal#api" target="_blank">BriefVerzenden.nl business portal</a>.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
				'X-Bron': 'n8n',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://www.briefverzenden.nl/api/v1',
			url: '/me',
			method: 'GET',
		},
	};
}
