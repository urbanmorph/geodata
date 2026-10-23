// Wires the header's "Install app" button (rendered hidden by renderNav in
// scripts/shared-chrome.mjs) on every prerendered page, and the offline page.
import { mountInstallButton } from './install-button';
import { registerOfflinePage } from './offline';

mountInstallButton(document.querySelector<HTMLButtonElement>('#install-app'), { appName: 'bharatlas' });
registerOfflinePage();
