const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGET_URL = 'https://www.ctyun.cn/pricing/ecs';
const SUCCESS_LOG_FILE = '成功日志.json';
const ERROR_LOG_FILE = '错误日志.txt';
const RESULTS_DIR = path.join(__dirname, '爬取结果');
const DATA_DIR = path.join(__dirname, 'data');
const METADATA_FILE = 'ecs-zones-metadata.json';
const SIMPLE_FILE = 'ecs-zones-simple.json';

const INITIAL_WAIT = 4000;
const OPERATION_WAIT = 1200;
const AFTER_SELECT_WAIT = 1800;
const CLICK_WAIT = 350;
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const DEFAULT_BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=site-per-process',
  '--no-sandbox',
  '--disable-gpu'
];
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);
const BLOCKED_URL_PATTERN = /analytics|doubleclick|facebook|cnzz|baidu|umeng|beacon|fullstory|sentry/i;
const DEBUG_BROWSER = process.env.DEBUG_BROWSER === '1';
const HEADLESS_MODE = DEBUG_BROWSER ? false : process.env.HEADLESS === 'false' ? false : true;
const HEADLESS_IMPLEMENTATION = process.env.HEADLESS_IMPL === 'old' ? 'old' : 'new';
const SLOW_MO = DEBUG_BROWSER ? Number.parseInt(process.env.DEBUG_SLOWMO || '50', 10) : 0;
const BROWSER_CHANNEL =
  process.env.BROWSER_CHANNEL || process.env.PLAYWRIGHT_BROWSER || (process.env.PREFER_EDGE === '0' ? undefined : 'msedge');
const HAR_PATH = (() => {
  if (!process.env.ROUTE_HAR) return null;
  const raw = process.env.ROUTE_HAR.trim();
  if (!raw) return null;
  const pathModule = require('path');
  return pathModule.isAbsolute(raw) ? raw : pathModule.join(__dirname, raw);
})();
const DEFAULT_USER_AGENT =
  process.env.PLAYWRIGHT_DEFAULT_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
const DISABLE_ANIMATIONS_SCRIPT = `
  (() => {
    const style = document.createElement('style');
    style.innerHTML = '*,:after,:before{transition:none!important;animation:none!important;}';
    document.head.appendChild(style);
  })();
`;


const SELECTORS = {
  provinceInput: [
    'css=.regionLabel input[placeholder="区域"]',
    'css=input[placeholder="区域"]',
    '/html/body/div[1]/div/section[2]/div/div[2]/div[2]/div[2]/div/div/div/div[2]/div[2]/div[1]/div[2]/form/div[1]/div/div/div/div/input'
  ],
  provinceItems: [
    'css=body div.el-select-dropdown:not([style*="display: none"]) ul.arealist > li',
    'css=body div.el-select-dropdown ul.arealist > li',
    '/html/body/div[2]/div[2]/div/div[2]/ul/li'
  ],
  resourcePools: [
    'css=.el-form-item:has(>label:has-text("资源池")) .el-radio-group label',
    '/html/body/div[1]/div/section[2]/div/div[2]/div[2]/div[2]/div/div/div/div[2]/div[2]/div[1]/div[2]/form/div[2]/div/div/label'
  ],
  availabilityZones: [
    // 精确匹配：label文本必须是"可用区"，排除"付费类型"等干扰
    'css=.el-form-item:has(>div.el-form-item__label:text-is("可用区")) .el-radio-group label',
    'css=.el-form-item:has(>label:text-is("可用区")) .el-radio-group label',
    '/html/body/div[1]/div/section[2]/div/div[2]/div[2]/div[2]/div/div/div/div[2]/div[2]/div[1]/div[3]/form/div/div[2]/div/label'
  ],
  cpuSelect: [
    { selector: 'css=.el-form-item:has-text("全部CPU") .el-select__wrapper', nth: 0 },
    '/html/body/div[1]/div/section[2]/div/div[2]/div[2]/div[2]/div/div/div/div[2]/div[2]/div[1]/div[7]/form/div/div[2]/div[1]/div',
    '/html/body/div[1]/div/section[2]/div/div[2]/div[2]/div[2]/div/div/div/div[2]/div[2]/div[1]/div[8]/form/div/div[2]/div[1]/div'
  ],
  memorySelect: [
    { selector: 'css=.el-form-item:has-text("全部CPU") .el-select__wrapper', nth: 1 },
    '/html/body/div[1]/div/section[2]/div/div[2]/div[2]/div[2]/div/div/div/div[2]/div[2]/div[1]/div[7]/form/div/div[2]/div[2]/div',
    '/html/body/div[1]/div/section[2]/div/div[2]/div[2]/div[2]/div/div/div/div[2]/div[2]/div[1]/div[8]/form/div/div[2]/div[2]/div'
  ],
  cpuDropdown: [
    'css=.el-select-dropdown:has-text("全部CPU") ul',
    'css=.el-select-dropdown:has(ul li:has-text("核")) ul',
    '/html/body/div[2]/div[3]/div/div/div[1]/ul'
  ],
  memoryDropdown: [
    'css=.el-select-dropdown:has-text("全部内存") ul',
    'css=.el-select-dropdown:has(ul li:has-text("G")) ul',
    '/html/body/div[2]/div[4]/div/div/div[1]/ul'
  ],
  cpuArchitecture: [
    'css=.el-form-item:has-text("CPU架构") .el-radio-group label',
    '/html/body/div[1]/div/section[2]/div/div[2]/div[2]/div[2]/div/div/div/div[2]/div[2]/div[1]/div[6]/form/div/div[2]/div/label[1]'
  ]
};

function log(message) {
  console.log(message);
}

function loadSuccessLog() {
  try {
    const filePath = path.join(__dirname, SUCCESS_LOG_FILE);
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
  } catch (error) {
    log(`读取成功日志失败: ${error.message}`, 'WARN');
    return {};
  }
}

function saveSuccessLog(data) {
  try {
    fs.writeFileSync(path.join(__dirname, SUCCESS_LOG_FILE), JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    log(`保存成功日志失败: ${error.message}`, 'ERROR');
  }
}

function getSuccessKey(province, pool, zone) {
  return `${province}-${pool}-${zone}`;
}

function shouldScrape(successLog, province, pool, zone) {
  const key = getSuccessKey(province, pool, zone);
  if (!successLog[key]) {
    log(`  → 首次爬取: ${key}`);
  } else {
    log(`  → 重新爬取: ${key}`);
  }
  return true;
}

function recordSuccess(successLog, province, pool, zone, cpuOptions, memoryOptions) {
  const key = getSuccessKey(province, pool, zone);
  successLog[key] = {
    province,
    pool,
    zone,
    cpuCount: cpuOptions.length,
    memCount: memoryOptions.length,
    cpuOptions,
    memoryOptions,
    timestamp: new Date().toISOString()
  };
  saveSuccessLog(successLog);
}

function logError(province, pool, zone, error, stack = '') {
  const timestamp = new Date().toISOString();
  const zoneLabel = zone ? ` - ${zone}` : '';
  const line = `[${timestamp}] ${province} - ${pool}${zoneLabel}: ${error}\n${stack ? `堆栈: ${stack}\n` : ''}${'='.repeat(60)}\n`;
  fs.appendFileSync(path.join(__dirname, ERROR_LOG_FILE), line, 'utf8');
  log(`  ✗ ${province} - ${pool}${zoneLabel}: ${error}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeName(value = '') {
  return value.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
}

async function tryEnableHarReplay(context) {
  if (!HAR_PATH) return false;
  if (!fs.existsSync(HAR_PATH)) {
    log(`HAR 文件未找到: ${HAR_PATH}`, 'WARN');
    return false;
  }
  try {
    await context.routeFromHAR(HAR_PATH, { url: '**/*', notFound: 'fallback' });
    log(`已开启 HAR 缓存加速: ${HAR_PATH}`);
    return true;
  } catch (error) {
    log(`HAR 缓存启用失败: ${error.message}`, 'WARN');
    return false;
  }
}

async function createOptimizedContext() {
  const launchOptions = {
    headless: HEADLESS_MODE,
    slowMo: SLOW_MO,
    args: [...DEFAULT_BROWSER_ARGS]
  };
  if (HEADLESS_MODE) {
    launchOptions.args.push(`--headless=${HEADLESS_IMPLEMENTATION}`);
  }
  if (BROWSER_CHANNEL) launchOptions.channel = BROWSER_CHANNEL;

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (error) {
    if (launchOptions.channel) {
      log(`使用 ${launchOptions.channel} 启动失败，改用内置 Chromium: ${error.message}`, 'WARN');
      delete launchOptions.channel;
      browser = await chromium.launch(launchOptions);
    } else {
      throw error;
    }
  }

  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    bypassCSP: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: process.env.USER_AGENT || DEFAULT_USER_AGENT,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    colorScheme: process.env.COLOR_SCHEME === 'dark' ? 'dark' : 'light',
    screen: DEFAULT_VIEWPORT
  });
  context.setDefaultTimeout(35000);
  context.setDefaultNavigationTimeout(45000);
  await context.addInitScript(DISABLE_ANIMATIONS_SCRIPT);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });
  log(`浏览器模式: ${launchOptions.channel || 'chromium'} | headless=${HEADLESS_MODE ? HEADLESS_IMPLEMENTATION : 'disabled'}`);
  await tryEnableHarReplay(context);
  return { browser, context };
}

async function setupPageNetworkFilters(page) {
  await page.route('**/*', (route) => {
    const request = route.request();
    const type = request.resourceType();
    const url = request.url();
    if (BLOCKED_RESOURCE_TYPES.has(type)) return route.abort();
    if (BLOCKED_URL_PATTERN.test(url)) return route.abort();
    route.continue();
  });
  page.setDefaultTimeout(35000);
  page.setDefaultNavigationTimeout(45000);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: process.env.COLOR_SCHEME === 'dark' ? 'dark' : 'light' });
}

function buildLocatorDescriptor(page, target) {
  if (!target) throw new Error('无效的 Selector');
  if (typeof target === 'string') {
    if (target.startsWith('css=') || target.startsWith('xpath=') || target.startsWith('text=')) {
      return { locator: page.locator(target), selectorSource: target };
    }
    return { locator: page.locator(`xpath=${target}`), selectorSource: `xpath=${target}` };
  }
  if (typeof target === 'object' && target.selector) {
    const base = buildLocatorDescriptor(page, target.selector);
    const locator = typeof target.nth === 'number' ? base.locator.nth(target.nth) : base.locator;
    const selectorSource = typeof target.nth === 'number'
      ? `${base.selectorSource}::nth(${target.nth})`
      : base.selectorSource;
    return { locator, selectorSource };
  }
  if (typeof target === 'object' && typeof target.count === 'function') {
    return { locator: target, selectorSource: '<locator>' };
  }
  throw new Error('暂不支持的 selector 类型');
}

async function logProvinceDropdownDebug(page) {
  try {
    const info = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('div.el-select-dropdown')).map((el, index) => ({
        index,
        className: el.className,
        style: el.getAttribute('style') || '',
        visible: window.getComputedStyle(el).display !== 'none',
        hasAreaList: !!el.querySelector('ul.arealist')
      }));
    });
    log(`  ⚠ 省份下拉列表状态: ${JSON.stringify(info)}`);
  } catch (error) {
    log(`  ⚠ 省份下拉列表调试失败: ${error.message}`);
  }
}

async function clickElement(page, targets, description, timeout = 8000) {
  const candidates = Array.isArray(targets) ? targets : [targets];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const { locator } = buildLocatorDescriptor(page, candidate);
      await locator.waitFor({ state: 'visible', timeout });
      await locator.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      await locator.click({ timeout: 5000 });
      log(`  ✓ 点击: ${description}`);
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  log(`  ✗ 点击失败 ${description}: ${lastError ? lastError.message : '未知错误'}`, 'WARN');
  return false;
}

async function resolveFirstLocator(page, selectors, description, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const selector of selectors) {
      try {
        const descriptor = buildLocatorDescriptor(page, selector);
        const list = descriptor.locator;
        const count = await list.count();
        if (!count) continue;
        for (let i = 0; i < count; i++) {
          try {
            if (await list.nth(i).isVisible()) {
              return descriptor;
            }
          } catch (error) {}
        }
      } catch (error) {}
    }
    await page.waitForTimeout(120);
  }
  throw new Error(`未找到 ${description}`);
}

async function collectRadioOptions(page, selectors, description) {
  for (const selector of selectors) {
    try {
      const { locator, selectorSource } = buildLocatorDescriptor(page, selector);
      const count = await locator.count();
      if (!count) continue;
      const results = [];
      for (let i = 0; i < count; i++) {
        const item = locator.nth(i);
        try {
          if (!(await item.isVisible())) continue;
        } catch (error) {
          continue;
        }
        const text = ((await item.textContent()) || '').trim();
        if (!text) continue;
        results.push({ name: text, selector: selectorSource, index: i });
      }
      if (results.length) return results;
    } catch (error) {}
  }
  log(`  ⚠ 未找到 ${description}`, 'WARN');
  return [];
}

async function clickByDescriptor(page, descriptor, description) {
  const { locator } = buildLocatorDescriptor(page, descriptor.selector);
  const target = typeof descriptor.index === 'number' ? locator.nth(descriptor.index) : locator;
  await target.waitFor({ state: 'visible', timeout: 8000 });
  await target.click({ timeout: 5000 });
  log(`  ✓ 点击: ${description}`);
}

function formatOptionPath(selectorSource, index) {
  if (!selectorSource || selectorSource === '<locator>') {
    return `index:${index + 1}`;
  }
  if (selectorSource.startsWith('xpath=')) {
    return `${selectorSource.replace('xpath=', '')}/li[${index + 1}]`;
  }
  if (selectorSource.startsWith('css=')) {
    return `${selectorSource} >> li:nth-of-type(${index + 1})`;
  }
  return `${selectorSource} -> li[${index + 1}]`;
}

async function openProvinceDropdown(page) {
  const opened = await clickElement(page, SELECTORS.provinceInput, '省份下拉框');
  if (!opened) throw new Error('无法打开省份下拉框');
  await page.waitForTimeout(CLICK_WAIT);
}

async function getAllProvinces(page) {
  await openProvinceDropdown(page);
  const { locator } = await resolveFirstLocator(page, SELECTORS.provinceItems, '省份列表');
  const count = await locator.count();
  const provinces = new Set();
  for (let i = 0; i < count; i++) {
    const name = ((await locator.nth(i).textContent()) || '').trim();
    if (name) provinces.add(name);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(CLICK_WAIT);
  const list = Array.from(provinces);
  log(`共获取到 ${list.length} 个省份`);
  return list;
}

async function selectProvince(page, provinceName) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await openProvinceDropdown(page);
      await page.waitForTimeout(CLICK_WAIT);
      const { locator } = await resolveFirstLocator(page, SELECTORS.provinceItems, '省份列表');
      const options = locator.filter({ hasText: provinceName });
      const count = await options.count();
      if (!count) throw new Error(`未找到省份: ${provinceName}`);
      for (let i = count - 1; i >= 0; i--) {
        const option = options.nth(i);
        if (await option.isVisible()) {
          await option.waitFor({ state: 'visible', timeout: 10000 });
          await option.click();
          await page.waitForTimeout(OPERATION_WAIT);
          return;
        }
      }
      throw new Error(`省份 ${provinceName} 不可见`);
    } catch (error) {
      if (attempt === 2) {
        await logProvinceDropdownDebug(page);
        throw error;
      }
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
    }
  }
}


async function getResourcePools(page, provinceName) {
  log(`  获取资源池: ${provinceName}`);
  await selectProvince(page, provinceName);
  const pools = await collectRadioOptions(page, SELECTORS.resourcePools, '资源池');
  if (!pools.length) {
    log(`  ⚠ ${provinceName} 没有可用的资源池`, 'WARN');
  } else {
    log(`  ✓ ${provinceName} 共有 ${pools.length} 个资源池`);
  }
  return pools;
}

async function selectResourcePool(page, pool) {
  await clickByDescriptor(page, pool, `资源池: ${pool.name}`);
  await page.waitForTimeout(AFTER_SELECT_WAIT);
}

// 非可用区的关键词，用于过滤误匹配
const INVALID_ZONE_KEYWORDS = ['付费', '包年', '包月', '按需', '按量', '预付', '后付'];

function isValidZoneName(name) {
  if (!name) return false;
  // 有效的可用区名称通常是：可用区1、可用区2、随机分配、AZ1、AZ2 等
  // 排除付费类型
  for (const keyword of INVALID_ZONE_KEYWORDS) {
    if (name.includes(keyword)) return false;
  }
  return true;
}

async function getAvailabilityZones(page) {
  const zones = await collectRadioOptions(page, SELECTORS.availabilityZones, '可用区');
  // 过滤掉误匹配的付费类型选项
  const validZones = zones.filter(z => isValidZoneName(z.name));
  if (zones.length > 0 && validZones.length === 0) {
    log(`  ⚠ 检测到的"可用区"实为付费类型，已过滤: ${zones.map(z => z.name).join(', ')}`, 'WARN');
  }
  return validZones;
}

async function selectAvailabilityZone(page, zone) {
  if (!zone) return;
  await clickByDescriptor(page, zone, `可用区: ${zone.name}`);
  await page.waitForTimeout(OPERATION_WAIT);
}

async function selectCpuArchitecture(page) {
  for (const selector of SELECTORS.cpuArchitecture) {
    try {
      const { locator } = buildLocatorDescriptor(page, selector);
      const target = locator.first();
      await target.waitFor({ state: 'visible', timeout: 2000 });
      await target.click({ timeout: 2000 });
      log('  ✓ 点击: CPU架构(x86)');
      await page.waitForTimeout(CLICK_WAIT);
      return;
    } catch (error) {}
  }
  log('  ℹ CPU架构可能已默认选中或无需选择');
}

async function resolveDropdownList(page, selectorList, fallbackXpath, description) {
  for (const selector of selectorList) {
    try {
      const descriptor = buildLocatorDescriptor(page, selector);
      await descriptor.locator.first().waitFor({ state: 'visible', timeout: 8000 });
      return descriptor;
    } catch (error) {}
  }
  const fallback = buildLocatorDescriptor(page, `xpath=${fallbackXpath}`);
  await fallback.locator.first().waitFor({ state: 'visible', timeout: 8000 });
  log(`      ℹ 使用 XPath 兜底: ${description}`);
  return fallback;
}

async function scrapeCPUOptions(page) {
  try {
    log('    爬取CPU选项...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);

    let opened = false;
    for (const target of SELECTORS.cpuSelect) {
      if (await clickElement(page, target, 'CPU选择框', 6000)) {
        opened = true;
        break;
      }
    }
    if (!opened) throw new Error('无法打开CPU选择框');

    await page.waitForTimeout(OPERATION_WAIT);
    let listDescriptor;
    try {
      listDescriptor = await resolveDropdownList(page, SELECTORS.cpuDropdown, '/html/body/div[2]/div[3]/div/div/div[1]/ul', 'CPU选项列表');
    } catch (error) {
      log('      ⚠ CPU选项列表未出现，尝试重新打开...', 'WARN');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      opened = false;
      for (const target of SELECTORS.cpuSelect) {
        if (await clickElement(page, target, 'CPU选择框(重试)', 6000)) {
          opened = true;
          break;
        }
      }
      if (!opened) throw new Error('重试后仍无法打开CPU选择框');
      await page.waitForTimeout(OPERATION_WAIT);
      listDescriptor = await resolveDropdownList(page, SELECTORS.cpuDropdown, '/html/body/div[2]/div[3]/div/div/div[1]/ul', 'CPU选项列表');
    }

    const options = listDescriptor.locator.locator('li');
    const count = await options.count();
    const results = [];
    for (let i = 0; i < count; i++) {
      try {
        const text = ((await options.nth(i).textContent()) || '').trim();
        if (!text) continue;
        const mark = formatOptionPath(listDescriptor.selectorSource, i);
        results.push(`${text} ${mark}`);
      } catch (error) {
        log(`      ⚠ 获取CPU选项失败: ${error.message}`, 'WARN');
      }
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(CLICK_WAIT);
    log(`    ✓ 获取到 ${results.length} 个CPU选项`);
    return results;
  } catch (error) {
    log(`    ✗ CPU选项爬取失败: ${error.message}`, 'ERROR');
    try {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(CLICK_WAIT);
    } catch (e) {}
    return [];
  }
}

async function scrapeMemoryOptions(page) {
  try {
    log('    爬取内存选项...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);

    let opened = false;
    for (const target of SELECTORS.memorySelect) {
      if (await clickElement(page, target, '内存选择框', 6000)) {
        opened = true;
        break;
      }
    }
    if (!opened) throw new Error('无法打开内存选择框');

    await page.waitForTimeout(OPERATION_WAIT);
    let listDescriptor;
    try {
      listDescriptor = await resolveDropdownList(page, SELECTORS.memoryDropdown, '/html/body/div[2]/div[4]/div/div/div[1]/ul', '内存选项列表');
    } catch (error) {
      log('      ⚠ 内存选项列表未出现，尝试重新打开...', 'WARN');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      opened = false;
      for (const target of SELECTORS.memorySelect) {
        if (await clickElement(page, target, '内存选择框(重试)', 6000)) {
          opened = true;
          break;
        }
      }
      if (!opened) throw new Error('重试后仍无法打开内存选择框');
      await page.waitForTimeout(OPERATION_WAIT);
      listDescriptor = await resolveDropdownList(page, SELECTORS.memoryDropdown, '/html/body/div[2]/div[4]/div/div/div[1]/ul', '内存选项列表');
    }

    const options = listDescriptor.locator.locator('li');
    const count = await options.count();
    const results = [];
    for (let i = 0; i < count; i++) {
      try {
        const text = ((await options.nth(i).textContent()) || '').trim();
        if (!text) continue;
        const mark = formatOptionPath(listDescriptor.selectorSource, i);
        results.push(`${text} ${mark}`);
      } catch (error) {
        log(`      ⚠ 获取内存选项失败: ${error.message}`, 'WARN');
      }
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(CLICK_WAIT);
    log(`    ✓ 获取到 ${results.length} 个内存选项`);
    return results;
  } catch (error) {
    log(`    ✗ 内存选项爬取失败: ${error.message}`, 'ERROR');
    try {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(CLICK_WAIT);
    } catch (e) {}
    return [];
  }
}

async function scrapeZoneData(page, province, poolName, zoneName, zoneDescriptor, outputDir, successLog) {
  if (!shouldScrape(successLog, province, poolName, zoneName)) {
    log(`    → 缓存有效，跳过 ${zoneName}`);
    return { skipped: true };
  }

  if (zoneDescriptor) {
    await selectAvailabilityZone(page, zoneDescriptor);
  }
  await selectCpuArchitecture(page);

  const cpuOptions = await scrapeCPUOptions(page);
  if (!cpuOptions.length) throw new Error('CPU选项为空');
  const memOptions = await scrapeMemoryOptions(page);
  if (!memOptions.length) throw new Error('内存选项为空');

  ensureDir(outputDir);
  fs.writeFileSync(path.join(outputDir, 'CPU-可选项.txt'), cpuOptions.join('\n'), 'utf8');
  fs.writeFileSync(path.join(outputDir, '内存-可选项.txt'), memOptions.join('\n'), 'utf8');
  log(`    ✓ ${zoneName} 选项已保存 (CPU:${cpuOptions.length} / 内存:${memOptions.length})`);
  const metadata = {
    provinceName: province,
    poolName,
    zoneName,
    cpuOptions,
    memoryOptions: memOptions,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(outputDir, 'zone-data.json'), JSON.stringify(metadata, null, 2), 'utf8');
  recordSuccess(successLog, province, poolName, zoneName, cpuOptions, memOptions);
  return { success: true };
}

async function scrapeResourcePool(page, province, pool, stats, successLog) {
  await selectResourcePool(page, pool);
  const poolDir = path.join(RESULTS_DIR, sanitizeName(province), sanitizeName(`${province}-${pool.name}`));
  ensureDir(poolDir);

  // 简化逻辑：如果有可用区就选第一个，没有就跳过
  const zones = await getAvailabilityZones(page);
  let zoneName = null;
  let zoneDescriptor = null;

  if (zones.length > 0) {
    // 有可用区，选第一个
    zoneDescriptor = zones[0];
    zoneName = zones[0].name;
    log(`  ℹ 检测到 ${zones.length} 个可用区，选择第一个: ${zoneName}`);
  } else {
    // 没有可用区，不需要选择
    zoneName = null;
    log(`  ℹ 该资源池无可用区选项`);
  }

  try {
    const result = await scrapeZoneData(page, province, pool.name, zoneName, zoneDescriptor, poolDir, successLog);
    stats.total++;
    if (result.skipped) {
      stats.skipped++;
    } else if (result.success) {
      stats.success++;
    }
  } catch (error) {
    stats.total++;
    stats.failed++;
    const zoneLabel = zoneName || '无可用区';
    log(`  ✗ 失败: ${province} - ${pool.name} - ${zoneLabel} - ${error.message}`, 'ERROR');
    logError(province, pool.name, zoneLabel, error.message, error.stack || '');
  }
  await page.waitForTimeout(700);
}

async function scrapeProvince(page, province, stats, successLog) {
  log(`\n========== ${province} ==========\n`);
  try {
    const pools = await getResourcePools(page, province);
    if (!pools.length) return;
    for (const pool of pools) {
      await scrapeResourcePool(page, province, pool, stats, successLog);
      await page.waitForTimeout(800);
    }
  } catch (error) {
    log(`✗ 处理省份失败 ${province}: ${error.message}`, 'ERROR');
  }
}

// 生成汇总数据文件到 data 目录
function generateDataFiles(successLog) {
  ensureDir(DATA_DIR);

  // 构建 metadata 数据结构
  const metadata = {
    updatedAt: new Date().toISOString(),
    totalRecords: Object.keys(successLog).length,
    records: []
  };

  // 构建 simple 数据结构（简化列表）
  const simpleList = [];

  for (const record of Object.values(successLog)) {
    // metadata 包含完整信息
    metadata.records.push({
      province: record.province,
      pool: record.pool,
      availabilityZone: record.zone,  // 可用区，可能为 null
      cpuCount: record.cpuCount,
      memCount: record.memCount,
      cpuOptions: record.cpuOptions || [],
      memoryOptions: record.memoryOptions || [],
      timestamp: record.timestamp
    });

    // simple 只包含地区标识
    simpleList.push({
      province: record.province,
      pool: record.pool,
      availabilityZone: record.zone
    });
  }

  // 按省份排序
  metadata.records.sort((a, b) => a.province.localeCompare(b.province, 'zh-CN'));
  simpleList.sort((a, b) => a.province.localeCompare(b.province, 'zh-CN'));

  // 写入文件
  const metadataPath = path.join(DATA_DIR, METADATA_FILE);
  const simplePath = path.join(DATA_DIR, SIMPLE_FILE);

  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  fs.writeFileSync(simplePath, JSON.stringify(simpleList, null, 2), 'utf8');

  log(`\n数据文件已生成:`);
  log(`  - ${metadataPath}`);
  log(`  - ${simplePath}`);
}

async function main() {
  // 清空错误日志
  const errorLogPath = path.join(__dirname, ERROR_LOG_FILE);
  if (fs.existsSync(errorLogPath)) fs.unlinkSync(errorLogPath);

  const successLog = loadSuccessLog();
  log(`已加载成功日志，共 ${Object.keys(successLog).length} 条记录`);
  log('开始爬取...\n');

  const { browser, context } = await createOptimizedContext();
  const page = await context.newPage();
  await setupPageNetworkFilters(page);

  const stats = { total: 0, success: 0, failed: 0, skipped: 0, start: Date.now() };

  try {
    log('加载页面...');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(INITIAL_WAIT);
    log('页面加载完成');

    const provinces = await getAllProvinces(page);
    if (!provinces.length) throw new Error('未获取到任何省份');

    const limit = parseInt(process.env.PROVINCE_LIMIT || '', 10);
    const targetProvinces = Number.isFinite(limit) && limit > 0 ? provinces.slice(0, limit) : provinces;

    log(`准备爬取 ${targetProvinces.length} 个省份\n`);
    for (let i = 0; i < targetProvinces.length; i++) {
      if (i > 0) await page.waitForTimeout(800);
      await scrapeProvince(page, targetProvinces[i], stats, successLog);
    }
  } catch (error) {
    log(`✗ 发生异常: ${error.message}`, 'ERROR');
  } finally {
    const duration = ((Date.now() - stats.start) / 1000).toFixed(1);
    log('\n========================================');
    log('爬取完成');
    log('========================================');
    log(`总数: ${stats.total} | 成功: ${stats.success} | 跳过: ${stats.skipped} | 失败: ${stats.failed}`);
    log(`成功率: ${stats.total ? (((stats.success + stats.skipped) / stats.total) * 100).toFixed(1) : 0}%`);
    log(`总耗时: ${duration} 秒`);
    log('========================================\n');

    // 生成 data 目录下的汇总文件
    generateDataFiles(successLog);

    await browser.close();
    console.log(`成功日志: ${path.join(__dirname, SUCCESS_LOG_FILE)}`);
    console.log(`错误日志: ${errorLogPath}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('程序异常:', error);
    process.exit(1);
  });
}

module.exports = { main };





