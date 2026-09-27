# Suranga FarmBook

**Farm Management & Expense Records** · Owner: Suranga

Suranga FarmBook is a static Progressive Web App. Farm, expense, income and settings records stay in the browser's local storage on each device. The public website hosts only the app files; it does not receive or synchronize farm records.

## Open locally on Windows

No Python, Node.js or other programming runtime is needed. Windows PowerShell is already part of Windows 10 and 11.

1. Open the repository folder.
2. Double-click `start-farmbook.bat`.
3. Use the local address shown in the browser (usually `http://localhost:8000/`). Leave the small server window open while using the local copy.

This local address is only for the same computer. To use FarmBook on a phone, first publish it at an HTTPS address using the instructions below. Double-clicking `index.html` works for basic use, but browsers do not enable PWA installation or offline support for `file://` pages.

## Publish a public HTTPS copy with GitHub Pages

The deployable app files (`index.html`, CSS, JavaScript, manifest, service worker, and icons) are in this repository's root. The workflow at `.github/workflows/deploy-pages.yml` publishes those files. Local browser records and JSON backups are not included. GitHub Pages provides HTTPS, which Chrome needs for Android PWA installation. On GitHub Free, the repository must be public for Pages to be available. [GitHub Pages overview](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) · [Custom workflow setup](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

1. Sign in or create an account at [GitHub](https://github.com/).
2. Create a **public** repository named `suranga-farmbook`. Leave **Add a README**, `.gitignore`, and license unchecked so the repository starts empty. GitHub Pages on the Free plan requires a public repository.
3. Install [GitHub Desktop](https://desktop.github.com/) and sign in. This optional publishing tool provides buttons for copying the project to GitHub; it is not needed to run FarmBook.
4. In GitHub Desktop, choose **File → Clone Repository**, select `suranga-farmbook` from your GitHub repositories, and clone it to a convenient local folder.
5. Copy the contents of this project folder into the cloned repository folder. Make sure `index.html`, `styles.css`, `app.js`, `manifest.json`, `sw.js`, both PNG icons, `icon.svg`, and `.github/workflows/deploy-pages.yml` are at the repository root or under `.github` as shown. If `.github` is hidden, turn on **View → Show → Hidden items** in File Explorer. Do not add a JSON backup of farm records.
6. Return to GitHub Desktop. The project files should appear under **Changes**. Enter `Add Suranga FarmBook` as the summary and click **Commit to main**, then click **Push origin**.
7. On GitHub, open the repository's **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. The workflow runs after the push to `main`. Follow its progress under **Actions**.
8. When the workflow succeeds, open **Settings → Pages** to see the public address. A project site usually has this form: `https://YOUR-GITHUB-NAME.github.io/suranga-farmbook/`.

The app uses relative asset paths, so it works from a GitHub Pages project URL as well as from a website's top-level path. Each later commit to `main` updates the site.

## Install on Windows

Open the public HTTPS address in Chrome or Edge on Windows. Choose **Install App** in FarmBook, or use the browser's **Install this site as an app** command. It opens in its own window. You can also install the local copy from `localhost` while its launcher is running.

## Install on Android

1. Open the public HTTPS FarmBook address in Chrome on the phone.
2. Let the page finish loading once.
3. Tap **Install App** if it appears, or open Chrome's menu and choose **Install app** / **Add to Home screen**.
4. Open FarmBook from the new home-screen icon. After its first successful load, the app shell can open offline.

On iPhone or iPad, open the HTTPS address in Safari, tap **Share**, then **Add to Home Screen**.

## Use FarmBook

- **Dashboard:** Review all-time, monthly and today's expenses, record count, key category totals, and cultivation-specific financial summaries. Select a cultivation to view its own figures.
- **Farms & Crops:** Manage cultivation cycles with unique IDs, land area, active/completed status and a permanent financial history. Complete a cycle when it ends; its expenses and income remain attached to it.
- **Expenses:** Add and edit expenses. Total cost is quantity × unit price. Search and filter by farm, crop, category, batch and dates.
- **Cultivation details:** Review a single cycle's expense and income records, category totals, profit/loss, status and dates, plus cost per acre/perch when land area is available.
- **Income:** Record sales and view income totals. Profit/loss is income minus expenses.
- **Reports:** View daily, monthly, cultivation, category and income-versus-expense reports. Print, save as PDF or export CSV.
- **Settings & Backup:** Manage app settings, install the app, export a full JSON backup or restore one.

## Back up and move records

1. On the device that has the records, open **Settings & Backup** and choose **Export Backup (JSON)**. Store the downloaded file somewhere safe.
2. Open the public HTTPS app on the destination device.
3. In **Settings & Backup**, choose **Import Backup (JSON)** and select the file. Import replaces records on that destination device after a confirmation prompt. Export a backup of its current data first if you need to keep it.

The public website does not copy records from the local `localhost` version automatically. Each browser and website address has separate storage. To move existing local records to the public copy, export the JSON from the local app and import it into the public app. Do not commit or upload the backup JSON file to the website repository. CSV exports contain expenses only and are not a full backup.

## Privacy and data safety

FarmBook does not require an account, send records to an external server or synchronize devices. Records are saved in the current browser on the current device. Clearing browser site data, using private browsing or changing browser profiles can remove or hide them, so keep regular JSON backups. The hosted files contain the application, not your records.
