import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const baselineDir = resolve(process.env.G1_OUTPUT_DIR || resolve(projectRoot, 'visual-baselines/g1-v2'));
const manifestPath = resolve(baselineDir, 'manifest.json');
const routes = [
  { id: 'user-center', hash: 'user-center', page: 'center' },
  { id: 'recharge', hash: 'recharge', page: 'recharge' },
  { id: 'records', hash: 'records', page: 'records' },
];
const payStates = ['hidden', 'disabled', 'enabled'];
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    resolve(projectRoot, 'node_modules/playwright-core'),
    resolve('D:/codex项目/用户中心充值方案预览/node_modules/playwright-core')
  ].filter(Boolean);
  const errors = [];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (error) { errors.push(`${candidate}: ${error.message}`); }
  }
  throw new Error(`找不到 playwright-core：${errors.join(' | ')}`);
}

async function fileDigest(relativePath) {
  const buffer = await readFile(resolve(projectRoot, relativePath));
  return { path: relativePath.replaceAll('\\', '/'), sha256: sha256(buffer) };
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function startPreview() {
  const configuredUrl = process.env.G1_BASE_URL;
  const candidates = [configuredUrl].filter(Boolean);
  for (const baseUrl of candidates) {
    try {
      const response = await fetch(baseUrl);
      const html = await response.text();
      if (response.ok && html.includes('圈像创作')) {
        return { baseUrl, child: null, output: () => 'reused existing preview' };
      }
    } catch {}
  }

  const port = await getFreePort();
  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'cmd.exe' : 'npm';
  const args = isWindows
    ? ['/d', '/s', '/c', `npm run dev -- --host localhost --port ${port}`]
    : ['run', 'dev', '--', '--host', 'localhost', '--port', String(port)];
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-12000); });
  child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-12000); });

  const baseUrl = `http://localhost:${port}`;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Preview exited early (${child.exitCode}).\n${output}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return { baseUrl, child, output: () => output };
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  await stopPreview(child);
  throw new Error(`Preview did not start within 45 seconds.\n${output}`);
}

async function stopPreview(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolveKill => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', resolveKill);
      killer.once('exit', resolveKill);
    });
    return;
  }
  child.kill('SIGTERM');
}

async function assertCorrectedSource() {
  const pageSource = await readFile(resolve(projectRoot, 'app/page.tsx'), 'utf8');
  const cssSource = await readFile(resolve(projectRoot, 'app/globals.css'), 'utf8');
  check(!pageSource.includes('className="mini-nav"'), 'fake navigation remains in app/page.tsx');
  check(!cssSource.includes('.mini-nav'), 'fake navigation styles remain in app/globals.css');
  check(pageSource.includes('data-g1-root'), 'missing data-g1-root capture marker');
  check(pageSource.includes("['全部', '充值', '消费', '奖励', '退款']"), 'records do not expose five approved filters');
  check(!/(支付宝|双通道|两个通道|哪个通道|星聚双通道|星聚官方插件)/.test(pageSource), 'legacy multi-provider payment copy remains in the preview');
  check(pageSource.includes('本次预计到账'), 'recharge still shows a client-computed post-balance');
  check(pageSource.includes('data-g1-cta-state'), 'three CTA states are not exposed for freezing');
}

async function readPageState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-g1-root]');
    const miniPage = root?.querySelector('.mini-page');
    const shell = root?.closest('.phone-shell');
    const box = element => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x * 1000) / 1000,
        y: Math.round(rect.y * 1000) / 1000,
        width: Math.round(rect.width * 1000) / 1000,
        height: Math.round(rect.height * 1000) / 1000,
      };
    };
    const keySelectors = [
      '.profile-card', '.balance-card', '.quick-grid', '.account-panel',
      '.recharge-balance', '.package-grid', '.channel-list', '.pay-button',
      '.record-summary', '.record-tabs', '.records-panel', '.transaction-row',
    ];
    const boxes = Object.fromEntries(keySelectors.map(selector => [selector, box(root?.querySelector(selector))]));
    const forbidden = ['.mini-nav', '.phone-status', '.phone-sensor', '.phone-home-bar', '.phone-shell'];
    const tabs = [...(root?.querySelectorAll('.record-tabs button') ?? [])];
    const channels = [...(root?.querySelectorAll('.channel-list button') ?? [])];
    const cta = root?.querySelector('[data-g1-cta]');
    const rootStyle = root ? getComputedStyle(root) : null;
    const pageStyle = miniPage ? getComputedStyle(miniPage) : null;
    return {
      page: root?.getAttribute('data-g1-page') ?? null,
      payState: root?.getAttribute('data-g1-pay-state') ?? null,
      captureShell: shell?.classList.contains('g1-capture-shell') ?? false,
      root: box(root),
      content: box(miniPage),
      scroll: root && miniPage ? {
        rootClientWidth: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
        pageClientWidth: miniPage.clientWidth,
        pageScrollWidth: miniPage.scrollWidth,
      } : null,
      forbidden: Object.fromEntries(forbidden.map(selector => [selector, root?.querySelectorAll(selector).length ?? -1])),
      boxes,
      tokens: {
        pageBackground: rootStyle?.backgroundColor ?? null,
        pagePadding: pageStyle?.padding ?? null,
      },
      tabCount: tabs.length,
      tabWidths: tabs.map(item => box(item)?.width ?? 0),
      channelCount: channels.length,
      channelLabels: channels.map(item => item.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
      hasAlipay: root?.textContent?.includes('支付宝') ?? false,
      expectedArrival: root?.querySelector('.recharge-balance')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      cta: cta ? {
        state: cta.getAttribute('data-g1-cta-state'),
        disabled: cta.matches(':disabled'),
        text: cta.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        box: box(cta),
      } : null,
    };
  });
}

function assertCommonState(state, expectedPage) {
  check(state.page === expectedPage, `expected page ${expectedPage}, got ${state.page}`);
  check(state.root && Math.abs(state.root.width - 338) <= 0.5, `${expectedPage} root width is not 338px`);
  check(state.root && Math.abs(state.root.height - 654) <= 0.5, `${expectedPage} root height is not 654px`);
  check(state.content && Math.abs(state.content.width - 338) <= 0.5, `${expectedPage} content width is not 338px`);
  check(state.tokens.pageBackground === 'rgb(245, 247, 251)', `${expectedPage} page background is not #f5f7fb`);
  check(state.tokens.pagePadding === '11px 12px 28px', `${expectedPage} page padding drifted from 11px 12px 28px`);
  check(state.captureShell === true, `${expectedPage} capture mode is not active`);
  check(Object.values(state.forbidden).every(count => count === 0), `${expectedPage} capture root contains system or fake navigation chrome`);
  check(state.scroll.rootScrollWidth <= state.scroll.rootClientWidth, `${expectedPage} root overflows horizontally`);
  check(state.scroll.pageScrollWidth <= state.scroll.pageClientWidth, `${expectedPage} page overflows horizontally`);
}

async function navigate(page, baseUrl, hash, payState) {
  await page.goto(`${baseUrl}/?payState=${payState}&capture=1#${hash}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-g1-root]').waitFor({ state: 'visible' });
  await page.locator('.phone-shell.g1-capture-shell').waitFor({ state: 'visible' });
  await page.waitForFunction(
    expected => document.querySelector('[data-g1-root]')?.getAttribute('data-g1-pay-state') === expected,
    payState,
  );
  await page.waitForTimeout(100);
}

async function freeze() {
  await mkdir(baselineDir, { recursive: true });
  const preview = await startPreview();
  const { chromium } = loadPlaywright();
  let browser;
  try {
    browser = await chromium.launch({
      channel: 'msedge',
      headless: true,
      args: ['--force-color-profile=srgb'],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const captures = {};

    for (const route of routes) {
      await navigate(page, preview.baseUrl, route.hash, 'enabled');
      const state = await readPageState(page);
      assertCommonState(state, route.page);
      if (route.id === 'records') {
        check(state.tabCount === 5, `records expected 5 tabs, got ${state.tabCount}`);
        check(Math.max(...state.tabWidths) - Math.min(...state.tabWidths) <= 1, 'record tabs are not equal width');
      }
      if (route.id === 'recharge') {
        check(state.channelCount === 1, `recharge expected one channel, got ${state.channelCount}`);
        check(!state.hasAlipay, 'recharge capture contains Alipay');
        check(state.expectedArrival?.includes('本次预计到账') && state.expectedArrival.includes('+330'), 'recharge expected-arrival copy is incorrect');
      }
      const screenshotPath = resolve(baselineDir, `${route.id}.png`);
      const rootRect = await page.locator('[data-g1-root]').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y) };
      });
      // Clip to integral CSS pixels: centered desktop shells often have fractional
      // coordinates, and locator screenshots would ceil to 339x655 physical pixels.
      await page.screenshot({
        path: screenshotPath,
        clip: { ...rootRect, width: 338, height: 654 },
        animations: 'disabled',
        caret: 'hide',
      });
      const screenshot = await readFile(screenshotPath);
      check(screenshot.readUInt32BE(16) === 338 && screenshot.readUInt32BE(20) === 654, `${route.id} screenshot is not 338x654`);
      captures[route.id] = {
        route: `#${route.hash}`,
        payState: 'enabled',
        screenshot: relative(baselineDir, screenshotPath).replaceAll('\\', '/'),
        screenshotSha256: sha256(screenshot),
        dom: state,
      };
    }

    const ctaStates = {};
    for (const payState of payStates) {
      ctaStates[payState] = {};
      for (const route of routes.slice(0, 2)) {
        await navigate(page, preview.baseUrl, route.hash, payState);
        const state = await readPageState(page);
        const expectedCount = payState === 'hidden' ? 0 : 1;
        check(Number(Boolean(state.cta)) === expectedCount, `${route.id}/${payState} CTA visibility is incorrect`);
        if (state.cta) {
          check(state.cta.state === payState, `${route.id}/${payState} CTA state marker is incorrect`);
          check(state.cta.disabled === (payState === 'disabled'), `${route.id}/${payState} CTA disabled state is incorrect`);
        }
        ctaStates[payState][route.id] = state.cta;
      }
    }

    if (failures.length) throw new Error(`G1 assertions failed:\n${failures.map(item => `- ${item}`).join('\n')}`);

    const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
    const sourceFiles = await Promise.all([
      'app/page.tsx',
      'app/globals.css',
      'scripts/freeze-g1.mjs',
      'package.json',
      'package-lock.json',
    ].map(fileDigest));
    const manifest = {
      schemaVersion: 1,
      contract: 'G1',
      previewVersion: packageJson.version,
      capture: {
        selector: '[data-g1-root]',
        viewport: { width: 338, height: 654, dpr: 1 },
        outerViewport: { width: 1440, height: 1000 },
        browser: `Microsoft Edge ${browser.version()}`,
        colorScheme: 'light',
        locale: 'zh-CN',
        scrollTop: 0,
      },
      fixture: {
        balance: 128.5,
        selectedProduct: { id: 'pkg_2990', price: '¥29.9', points: 330 },
        filters: ['全部', '充值', '消费', '奖励', '退款'],
        paymentChannel: 'wxpay',
      },
      sourceFiles,
      captures,
      ctaStates,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`G1 freeze PASS: ${manifestPath}`);
    for (const capture of Object.values(captures)) {
      console.log(`${capture.screenshot}  ${capture.screenshotSha256}`);
    }
  } finally {
    await browser?.close();
    await stopPreview(preview.child);
  }
}

async function main() {
  await assertCorrectedSource();
  if (failures.length) {
    throw new Error(`G1 source assertions failed:\n${failures.map(item => `- ${item}`).join('\n')}`);
  }
  await freeze();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
