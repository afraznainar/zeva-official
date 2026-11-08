# Zeva Mandi & Grills — working notes

## Save every change, locally and in git

Whenever anything in this project is updated — page copy, styles, Worker code,
print bridge, tooling, generated documents — finish the update by:

1. Writing the change to the file on disk (the OneDrive folder is the source of
   truth; `deploy/dist` is edited directly, there is no build step).
2. Committing it to git with a message that says *why* the change was made.
3. Pushing the commit to `origin` (`github.com/afraznainar/zeva-official`,
   branch `main`) so the backup stays current.

Check `git status` before finishing: nothing the change touched should be left
uncommitted. Leave unrelated in-flight edits out of the commit.

## Never commit secrets

`.tools/`, `deploy/.print-token`, `.env*`, `node_modules/` and log files are
gitignored and must stay that way. Credentials live on disk, never in the repo.

## Deploys

The live site is the Freebuff Sites preview
`https://site-67005eaaea074aab9c2d40a25debe4c7.freebuff.page`, deployed from
`deploy/sites.manifest.json`. Social share tags carry that origin absolutely —
if the site moves to a custom domain, run `node .tools/fix-og.js <new-origin>`.

## Android app (PWA)

`deploy/dist/app.html` is the installable ordering app at `/app`; it reads the
menu straight out of `menu.html` at runtime, so a menu edit needs no app change.
`manifest.webmanifest` and `sw.js` make it installable and keep it readable
offline. Its icons come from `deploy/make-favicon.ps1` (rerun it after a logo
change) and its `start_url` is absolute, so a move to a custom domain means
updating the manifest too.

## Menu spreadsheet

`Zeva-Menu.xlsx` is generated from `deploy/dist/menu.html` by
`node .tools/make-menu-xlsx.js`. Regenerate and commit it after any menu or
price change.
