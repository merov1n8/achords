# ADR-0047: Several sites per project, each with its own credentials

Status: Accepted (2026-11-21)

- Context: A client project could reach one WordPress site: its address came from the first entry of the project's `wordpress` account list, its credentials from `wordpress-user-<project>` / `wordpress-password-<project>`. An agency client may have ten sites, each with its own WordPress user and application password. Unlike Google or Meta (one shared sign-in, ADR-0036), every site is a separate login.

- Decision:
  - A catalog entry may declare `sites`: the account `channel` holding the addresses, the `env` var the server reads them from, per-site `secrets` (vault ids with `{project}` and `{site}`), and optionally `first`, the older ids that still apply to the first site when its own are not set (so existing single-site projects keep working without migration).
  - `{site}` is the address without scheme, lowercased, every other character run turned into `-` (`https://www.acme.example/blog` → `www-acme-example-blog`). An id longer than the vault's 64 characters is cut to 55 and ends with 8 hex characters of its SHA-256, so it stays deterministic and unique.
  - The launch gets only the project's sites whose credentials are all set, as JSON `[{url, ...secrets}]`; the others are left out of the run and named in "Not available in this run". No site with credentials: the integration is left out, the run goes on.
  - The tools take the site as an argument (`scope.args: [site]`); the launcher refuses other addresses as for every scoped integration. New `scope.optional`: the argument may be left out when the project has exactly one site.
  - The own pseudo-project (ADR-0042) follows the same rules with ids `…-own-<site>`. An owner-approved publish without a client project now uses the own accounts, as the run that asked did.
  - API: `GET/POST /api/projects/<slug>/sites/<integration>`, `DELETE …/sites/<integration>/<encoded url>` list, add and remove sites with per-site status (ids to set, which are missing, never values). Values go through the write-only vault API.

- Consequences: One WordPress entry serves any number of sites per client. A missing password on one site no longer takes the others out. The status (`integrationStatus.sites`) and the connection test report per site. Vault ids depend on the site address: changing an address means setting its credentials again.
