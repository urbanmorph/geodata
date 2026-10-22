// Wires the header's "Install app" button (rendered hidden by renderNav in
// scripts/shared-chrome.mjs) on every prerendered page.
import { mountInstallButton } from './install-button';

mountInstallButton(document.querySelector<HTMLButtonElement>('#install-app'), { appName: 'bharatlas' });
