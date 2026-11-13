# n8n-nodes-briefverzenden

An [n8n](https://n8n.io) community node for [BriefVerzenden.nl](https://www.briefverzenden.nl/zakelijk). Send real postal letters from a PDF in your workflows, track their delivery status and check your credit balance.

BriefVerzenden.nl prints your PDF, puts it in an envelope and posts it, in the Netherlands and to other countries. Letters are paid from the prepaid credit balance of a BriefVerzenden.nl business account. You top it up in the [business portal](https://www.briefverzenden.nl/zakelijk/portal).

[Installation](#installation) · [Operations](#operations) · [Credentials](#credentials) · [Trigger](#trigger) · [Errors](#errors) · [Without the community node](#without-the-community-node) · [Resources](#resources)

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n documentation. In short, for self-hosted n8n:

1. Sign in as the owner or an admin of your n8n instance.
2. Go to **Settings → Community Nodes → Install a community node**.
3. Enter `n8n-nodes-briefverzenden`, confirm that you understand the risks, and click **Install**.
4. Search for "BriefVerzenden" in the nodes panel.

If the menu is missing, community packages are disabled (`N8N_COMMUNITY_PACKAGES_ENABLED=false`). On n8n Cloud, only community nodes verified by n8n can be installed. You can also install the package manually, for example in Docker:

```bash
docker exec -it n8n sh
mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes
npm install n8n-nodes-briefverzenden
# then restart n8n
```

## Operations

| Node | Resource | Operation | API call |
|---|---|---|---|
| BriefVerzenden.nl | Letter | Send | `POST /brieven` |
| | Letter | Get | `GET /brieven/{id}` |
| | Letter | Get Many | `GET /brieven?limit=…&status=…` (one item per letter) |
| | Letter | Calculate Price | `POST /prijs` (sends nothing) |
| | Account | Get Balance | `GET /me` |
| BriefVerzenden.nl Trigger | | On letter status change (polling) | `GET /brieven?limit=100` |

The node uses the REST API at `https://www.briefverzenden.nl/api/v1`. Every letter you send is charged to the credit balance of your account. Use **Calculate Price** to check the cost first; it sends nothing and charges nothing.

### Send a letter

- **Recipient:** name, optional attention line, street address, postal code, city and country. The country list is loaded live from the API and defaults to the Netherlands. In an expression, use the two-letter ISO country code (for example `DE`).
- **PDF source:**
  - **Binary Field** (default field name `data`): the PDF from a previous step is uploaded. The maximum is 3 MB; for larger files the node stops and asks you to use a URL instead.
  - **URL:** BriefVerzenden.nl downloads the PDF itself (public HTTPS link, up to 10 MB).
- **PDF requirements:** A4, up to 60 pages. The address does not need to be in the PDF: a cover page with the address in the envelope window is added in front of it. The cover page is not counted as a page.
- **Options:** color, double-sided (on by default), registered mail, shipping speed (economy, standard, fast or plus; availability differs per country), a sender line, your own reference and an idempotency key.

#### Never send a letter twice

If you leave **Idempotency Key** empty, the node creates one. It is a hash of the n8n instance, the workflow, the node name, the execution ID, the item index and the content (recipient, options and a SHA-256 of the PDF or its URL). A retry within the same execution (**Retry On Fail**) gets the same letter back and sends nothing new. The output then contains `idempotentHerhaald: true`.

Note: **Retry** from the executions list starts a *new* execution in n8n, which gets a new key. If you never want a letter sent twice, even then, set your own key that belongs to the letter, for example `invoice-{{ $json.invoiceNumber }}`.

### Output fields

The node returns the API response as-is, so field names and status values are in Dutch. The most important ones:

| Field | Meaning |
|---|---|
| `id` | Letter ID (`brf_…`) |
| `status` | `ingediend` (submitted), `verzonden` (sent), `bezorgd` (delivered), `onbestelbaar` (undeliverable), `geannuleerd` (cancelled), `mislukt` (failed, amount refunded) |
| `prijs`, `valuta` | Price including VAT, currency (EUR) |
| `paginas` | Number of pages |
| `ontvanger` | Recipient (`naam`, `tav`, `adres`, `postcode`, `woonplaats`, `land`) |
| `opties` | `kleur` (color), `dubbelzijdig` (double-sided), `aangetekend` (registered) |
| `snelheid` | Shipping speed: `traag` (economy), `standaard`, `snel` (fast), `plus` |
| `referentie` | Your own reference |
| `volgnummer`, `volgUrl` | Tracking number and tracking link, once the carrier provides them |
| `tegoed.saldo` | Remaining credit balance (Send and Get Balance) |
| `idempotentHerhaald` | `true` if an earlier letter with the same idempotency key was returned instead of sending a new one |

Regular mail does not always report `bezorgd`; registered and tracked mail does.

## Credentials

Create a credential of type **BriefVerzenden.nl API** with one field: your API key (`bv_live_…`).

1. Sign in to the [BriefVerzenden.nl business portal](https://www.briefverzenden.nl/zakelijk/portal#api) and create an API key under **API en automatisering** (API and automation). The key is shown only once; store it like a password.
2. Paste it into the credential in n8n. **Test** calls `GET /me` and costs nothing.

The node sends the key as `Authorization: Bearer …`, together with `X-Bron: n8n`, so the portal shows which letters came from n8n. Create a separate key per integration; revoking a key takes effect immediately.

## Trigger

**BriefVerzenden.nl Trigger** is a polling trigger. On every poll it fetches the 100 most recent letters and compares their status with the previous poll (stored as `{ id: status }` in the workflow's static data). Letters whose status changed are output oldest first, with an extra field `vorigeStatus` (previous status).

- **First poll after activation:** the trigger only records the current statuses and outputs nothing, so you don't get a flood of old letters.
- **Manual test** (**Fetch Test Event**): returns the most recent letter that matches the filter, without changing the stored state.
- **Statuses:** choose which statuses fire the trigger, for example only Delivered or Undeliverable. Leave empty to fire on every change.
- **Include New Letters** (on by default): also fire for letters created since the previous poll. Their first status counts as a change.

### Limits

- Letters outside the 100 most recent are no longer seen by the trigger.
- Per list request, the API checks the carrier status of at most 20 open letters, and each letter at most once every 5 minutes. A poll interval of 15 minutes or more is plenty.
- The API allows about 2 requests per second per IP address (with a burst buffer); above that it returns HTTP 429.

## Errors

API errors become an n8n error with an English message. The description contains a tip where useful, the original explanation from the API (in Dutch) and the error code, for example:

- **401**: the API key is missing or invalid.
- **402** (`onvoldoende_tegoed`): insufficient credit balance. Nothing was sent; top up in the portal.
- **429**: too many requests. The description includes the wait time from `Retry-After`.
- **502** (`indienen_mislukt`): the carrier did not accept the letter. The amount has been refunded to your credit balance.

With **On Error → Continue**, each failed item returns `{ error, description, httpCode }` and the workflow keeps running.

## Without the community node

[`example-workflow.json`](https://github.com/thijnfelix/n8n-nodes-briefverzenden/blob/main/example-workflow.json) works in any n8n instance, including n8n Cloud, because it only uses the built-in HTTP Request node. To import it, create a new workflow, choose **⋯ → Import from File** and select the file.

- Create a credential of type **Header Auth** with Name `Authorization` and Value `Bearer bv_live_…`, and select it in both HTTP Request nodes.
- *Check Balance* calls `GET /me`. Use it to test your key at no cost.
- *Recipient and PDF* contains sample data. The PDF link points to a file that does not exist; if you leave it, the API rejects the letter and nothing is charged.
- *Send Letter* calls `POST /brieven` with an `Idempotency-Key` made from the workflow ID, execution ID and item index.

## Compatibility

Built with `@n8n/node-cli` (n8n nodes API version 1). The package has no runtime dependencies.

## Resources

- [BriefVerzenden.nl for businesses](https://www.briefverzenden.nl/zakelijk)
- [API documentation](https://www.briefverzenden.nl/zakelijk/api) (in Dutch)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- Support: support@briefverzenden.nl

## License

[MIT](LICENSE.md)
