import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, firefox, webkit } from 'playwright-core';
import { productionServer } from './production-server.mjs';

const project = fileURLToPath(new URL('../../..', import.meta.url));

async function verifyCookieTransport(context, workspaceUrl) {
  // A second loopback origin observes whether the browser includes the ephemeral test cookie.
  const probe = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/start') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<a href="http://127.0.0.1:' + probe.address().port + '/api/probe">Open probe</a>'
        + '<a href="' + workspaceUrl + '/api/workspace">Open workspace API</a>');
      return;
    }
    response.setHeader('Content-Type', 'text/plain');
    const cookiePresent = /(?:^|;\s*)paymandate_session=/.test(request.headers.cookie ?? '');
    response.end(cookiePresent ? 'present' : 'absent');
  });
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  let page;
  try {
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(12_000);
    await page.goto('http://127.0.0.1:' + port + '/api/probe');
    assert.equal(await page.locator('body').innerText(), 'present');
    await page.goto('http://localhost:' + port + '/start');
    await page.getByRole('link', { name: 'Open probe' }).click();
    await page.waitForURL('http://127.0.0.1:' + port + '/api/probe');
    const transported = await page.locator('body').innerText();
    await page.goto('http://localhost:' + port + '/start');
    const crossSiteApi = page.waitForResponse(response => response.url() === workspaceUrl + '/api/workspace');
    await page.getByRole('link', { name: 'Open workspace API' }).click();
    const denied = await crossSiteApi;
    assert.ok(denied.status() === 401 || denied.status() === 403);
    assert.equal((await denied.json()).invoices, undefined);
    return transported;
  } finally {
    await page?.close();
    const closing = new Promise(resolve => probe.close(resolve));
    probe.closeAllConnections();
    await closing;
  }
}

test('production workspace handles invoice review, authorization and mobile navigation', { timeout: 90_000 }, async context => {
  const data = await mkdtemp(join(tmpdir(), 'paymandate-smoke-'));
  const token = randomBytes(32).toString('hex');
  let server;
  let browser;
  try {
    server = await productionServer(data, token);
    const { request, url } = server;
    assert.equal((await request('/api/workspace')).status, 401);
    assert.equal((await request('/api/workspace', { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await request('/api/workspace', { method: 'POST', body: '{}', headers: { Origin: url } })).status, 401);
    assert.equal((await request('/api/workspace', {
      method: 'POST', body: '{}', headers: { Authorization: 'Bearer ' + token },
    })).status, 400);
    const publicState = await (await request('/api/chain')).json();
    assert.equal(publicState.connection, 'UNCONFIGURED');
    assert.equal(publicState.agentReady, undefined);

    const engines = { chromium, firefox, webkit };
    const engine = process.env.PAYMANDATE_BROWSER_ENGINE || 'chromium';
    assert.ok(Object.hasOwn(engines, engine), 'Unknown browser engine');
    browser = await engines[engine].launch({ executablePath: process.env.PAYMANDATE_BROWSER || undefined, headless: true, timeout: 15_000 });
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
    const page = await browserContext.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(12_000);
    context.diagnostic('Browser engine: ' + engine);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text() + " " + message.location().url); });
    const screenshotDir = process.env.PAYMANDATE_SCREENSHOTS;
    async function capture(name) {
      if (!screenshotDir) return;
      await mkdir(screenshotDir, { recursive: true });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(screenshotDir, name), fullPage: true });
    }

    const axeSource = process.env.PAYMANDATE_AXE ? await readFile(process.env.PAYMANDATE_AXE, 'utf8') : null;
    async function accessibility(label) {
      if (!axeSource) return;
      if (!await page.evaluate(() => Boolean(window.axe))) await page.evaluate(axeSource);
      const violations = await page.evaluate(async () => {
        const report = await window.axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
        return report.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(node => node.target) }));
      });
      assert.deepEqual(violations, [], label);
      context.diagnostic('axe WCAG 2.0/2.1 A/AA: ' + label);
    }

    const loaded = await page.goto(url);
    const csp = await loaded.headerValue('content-security-policy');
    assert.match(csp, /script-src .*'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    assert.match(csp, /frame-ancestors 'none'/);
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    await accessibility('auditor dashboard');
    await page.getByLabel('Workspace token').fill(token);
    const signIn = page.waitForResponse(response => response.url() === url + '/api/workspace/session' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    const signInResponse = await signIn;
    assert.match(await signInResponse.headerValue('set-cookie'), /; HttpOnly; SameSite=Strict;/);
    await page.getByText('Demo analysis mode', { exact: true }).waitFor();
    const cookie = (await page.context().cookies()).find(item => item.name === 'paymandate_session');
    assert.ok(cookie);
    assert.equal(cookie.httpOnly, true);
    const transported = await verifyCookieTransport(page.context(), url);
    if (engine !== 'webkit') assert.equal(transported, 'absent');
    context.diagnostic('Cross-site cookie at the loopback probe: ' + transported + '. Production API denied the cross-site navigation.');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('paymandate-session')), null);
    const crossSite = await request('/api/workspace/session', { method: 'DELETE', headers: {
      'X-PayMandate-Request': 'workspace', Origin: 'https://example.test', Cookie: cookie.name + '=' + cookie.value,
    } });
    assert.equal(crossSite.status, 403);
    await page.getByRole('button', { name: 'Invoices', exact: true }).click();
    for (const [file, invoice] of [['valid', 'NS-1042'], ['injection', 'NS-1043']]) {
      await page.locator('input[type=file]').setInputFiles(join(project, 'examples', 'invoices', file + '.txt'));
      await page.getByRole('button', { name: 'Analyze invoice', exact: true }).click();
      await page.getByRole('heading', { name: 'Review ' + invoice }).waitFor();
    }
    assert.equal(await page.getByLabel('Verified recipient').inputValue(), 'vendor.example.testnet');
    await page.getByText('Suspicious instructions found in the document.').waitFor();
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await page.getByRole('button', { name: 'Review invoice NS-1043', exact: true }).waitFor();
    await accessibility('operator dashboard');
    await capture('dashboard.png');
    await page.getByRole('button', { name: 'Review invoice NS-1043', exact: true }).click();
    await page.getByRole('heading', { name: 'Review NS-1043', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Review approval in wallet' }).isDisabled(), true);
    await page.getByText('Original invoice', { exact: true }).click();
    await accessibility('expanded invoice review');
    await capture('invoice-review.png');
    await page.reload();
    await page.getByText('Demo analysis mode', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Review', exact: true }).count(), 2);
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByText('No execution attempts recorded in this workspace.').waitFor();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Security Demo', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Security Demo', exact: true }).waitFor();
    const buttons = await page.getByRole('button', { name: 'Run on Testnet' }).all();
    assert.equal(buttons.length, 4);
    for (const button of buttons) assert.equal(await button.isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await accessibility('mobile security scenarios');
    await capture('security-mobile.png');
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const tab of ['Dashboard', 'Invoices', 'Mandates', 'Activity', 'Security Demo']) {
        await page.getByRole('button', { name: tab, exact: true }).click();
        await page.getByRole('heading', { name: tab, exact: true, level: 1 }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, tab + ' at ' + width + 'px');
      }
    }
    context.diagnostic('All five workspace screens checked at 320, 390, 768, 1024 and 1440 px.');
    await page.getByRole('button', { name: 'Lock workspace', exact: true }).click();
    await page.getByText('Auditor view', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Review', exact: true }).count(), 0);
    const replay = await request('/api/workspace', { headers: { 'X-PayMandate-Request': 'workspace', Cookie: cookie.name + '=' + cookie.value } });
    assert.equal(replay.status, 401);
    for (let i = 0; i < 9; i++) {
      const wrong = await request('/api/workspace/session', {
        method: 'POST', headers: { 'X-PayMandate-Request': 'workspace', Origin: url, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'wrong' }),
      });
      assert.equal(wrong.status, i < 8 ? 401 : 429);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server?.stop();
    await rm(data, { recursive: true, force: true });
  }
});
