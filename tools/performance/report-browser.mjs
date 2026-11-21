// Runs inside the operator's existing application tab. Keep all identifiers and DOM text here.
// The CLI serializes these functions and receives only fixed outcome codes and timings.
export function bonusReferenceError(expected, rowCount, matchCount, values) {
  if (!rowCount && expected.rows) return 'bonus_unexpected_empty';
  if (rowCount !== expected.rows) return 'bonus_row_count_mismatch';
  if (!rowCount) return;
  if (matchCount !== 1) return 'bonus_reference_row_missing';
  for (const key of ['sim0Bonus', 'totalBonus']) {
    if (key in expected && values[key] !== expected[key].toLocaleString('ro-RO')) return 'bonus_amount_mismatch';
  }
}

export async function observeReport(config, checkReference) {
  const {origin, role, months, expected, timeoutMs} = config;
  const annual = config.scenario === 'annual';
  const timingsMs = {}, apiMs = {}, fresh = new Set();
  let owner, start, failure, deadline, originalMonths, result;
  let stage = 'preflight';
  const fail = code => { failure = code; throw new Error(); };
  const now = () => performance.now();
  const elapsed = () => Math.round(now() - start);
  const visible = el => el?.checkVisibility({visibilityProperty: true, opacityProperty: true}) && el.getClientRects().length > 0;
  const one = (selector, root = document) => root && ([...root.querySelectorAll(selector)].find(visible) ?? null);
  const button = (root, label) => root && [...root.querySelectorAll('button')].find(b => visible(b) && !b.disabled && b.textContent.trim() === label);
  async function until(read, code) {
    do {
      if (failure) fail(failure);
      const value = read();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (now() < deadline);
    fail(code);
  }
  async function fetchPinned(path) {
    const response = await fetch(path, {credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs)});
    if (!response.ok) fail('preflight_http');
    return response;
  }
  async function checkIdentity() {
    if (location.origin !== origin) fail('wrong_origin');
    const {user} = await (await fetchPinned('/api/auth/session')).json();
    if (!user?.id || user.role !== role || !user.canViewActivations || user.mustChangePassword ||
        (owner && owner !== user.id) || (config.accountId && config.accountId !== user.id)) fail('session_mismatch');
    owner = user.id;
    const shell = await (await fetchPinned('/sw.js')).text();
    if (!shell.includes("const CACHE='mobiup-shell-v3-" + config.shellVersion + "';")) fail('release_mismatch');
    const assets = performance.getEntriesByType('resource').map(entry => new URL(entry.name, origin))
      .filter(url => url.origin === origin && url.pathname.startsWith('/_next/static/') && url.pathname.endsWith('.js'));
    if (!assets.length || assets.some(url => !shell.includes(JSON.stringify(url.pathname)))) fail('page_build_mismatch');
  }
  const monthLabels = ['Ian','Feb','Mar','Apr','Mai','Iun','Iul','Aug','Sep','Oct','Noi','Dec'];
  const picker = () => one('.report-period[aria-label="Perioadă"]');
  function selection() {
    const text = picker()?.querySelector('.report-period-selection')?.textContent;
    if (text === 'Nicio lună selectată') return [];
    if (!text) fail('month_picker_missing');
    return text.replace(' · maximum 36 de luni', '').split(' · ').map(part => {
      const [name, year] = part.split(' ');
      const index = monthLabels.indexOf(name);
      if (index < 0 || !/^20\d\d$/.test(year)) fail('month_picker_invalid');
      return year + '-' + String(index + 1).padStart(2, '0');
    });
  }
  async function setPeriod(target) {
    await until(picker, 'month_picker_missing');
    const selected = selection();
    for (const month of [...selected.filter(m => !target.includes(m)), ...target.filter(m => !selected.includes(m))]) {
      const [year, number] = month.split('-');
      const select = picker().querySelector('select');
      if (select.value !== year) {
        select.value = year;
        select.dispatchEvent(new Event('change', {bubbles: true}));
      }
      const label = new Intl.DateTimeFormat('ro-RO', {month:'long', timeZone:'UTC'}).format(new Date(month + '-15T12:00Z')) + ' ' + year;
      const toggle = await until(() => one('button[aria-label="' + label + '"]', picker()), 'month_unavailable');
      if (toggle.disabled || toggle.textContent !== monthLabels[Number(number) - 1]) fail('month_unavailable');
      toggle.click();
      await until(() => selection().includes(month) === target.includes(month), 'month_selection_mismatch');
    }
    if (selection().join() !== target.join()) fail('month_selection_mismatch');
  }
  // Observe the application's account-fenced, post-validation read events. No extra report requests.
  function phaseOf(url) {
    const p = url.searchParams;
    if (url.origin !== origin) return;
    if (annual && url.pathname === '/api/activations' && !p.has('view')) {
      if (p.get('provider') === 'digi') return 'digi';
      if (p.get('provider') === 'vodafone' && ['totals','panels','cards'].includes(p.get('overviewPhase'))) return p.get('overviewPhase');
    }
    if (!annual && url.pathname === '/api/vodafone/bonuses') {
      if (p.get('view') === 'preview') return 'bonus';
      if (!p.has('view')) return 'bonusFull';
    }
  }
  function matchesScope(p) {
    if (p.get('month') !== months[0] || (annual && p.get('months') !== months.join(','))) return false;
    if ([...p.keys()].some(key => p.getAll(key).length !== 1)) return false;
    const filters = ['managerId','agentId','siteCode'];
    if (filters.some(key => (p.get(key) ?? null) !== (config.scope[key] || null))) return false;
    if (p.has('projects') !== (role === 'manager') || p.has('months') !== annual) return false;
    if (!annual && [...p.keys()].some(key => !['month','view','projects',...filters].includes(key))) return false;
    return (p.get('projects') || '').split(',').filter(Boolean).sort().join() === config.scope.projects.join();
  }
  function freshness(event) {
    const detail = event.detail;
    const url = new URL('/api/' + detail.path, origin);
    const phase = phaseOf(url);
    if (!phase) return;
    if (detail.userId !== owner || detail.source !== 'network') failure = 'report_authority_mismatch';
    else if (!matchesScope(url.searchParams)) failure = 'report_scope_mismatch';
    else fresh.add(phase);
  }
  const workspace = () => one('.prepay-workspace');
  const report = () => one('.activation-workspace', workspace());
  const card = provider => one('article[aria-label="Activări ' + provider + '"]', report());
  const metric = (root, selector, value) => root && one(selector, root)?.textContent === value.toLocaleString('ro-RO');
  const products = key => '.activation-product-breakdown [aria-label="Evoluție lunară · ' + key + ' · Vodafone"] span';
  function annualReady() {
    const vodafone = card('vodafone'), digi = card('digi');
    if (role === 'agent' && (button(report(), 'Bonusuri Vodafone') || (vodafone && one('.activation-sim-zero', vodafone)))) fail('agent_manager_panel_visible');
    const hasVodafone = fresh.has('totals') || fresh.has('panels');
    const total = '.activation-primary strong';
    const coverage = expected.coverage;
    const commission = coverage === 'outside_scope' || coverage === 'missing'
      ? [...vodafone?.querySelectorAll('.activation-source-date') || []].some(el => visible(el) && el.textContent ===
        'Comisionabile · ' + (coverage === 'outside_scope' ? 'fără gestiuni eligibile în selecție' : 'fără sursă Vodafone pentru selecție'))
      : metric(vodafone, '.activation-eligibility .activation-trend-value span', expected.eligible) &&
        Boolean(vodafone.querySelector('p.activation-coverage-warning')) === (coverage === 'partial');
    return {
      vodafoneTotal: hasVodafone && metric(vodafone, total, expected.vodafone),
      digiTotal: fresh.has('digi') && metric(digi, total, expected.digi),
      vodafoneDetails: hasVodafone && metric(vodafone, products('SIM 0'), expected.simZero) && metric(vodafone, products('SIM cu credit'), expected.simCredit),
      vodafoneCommission: hasVodafone && commission,
    };
  }
  async function checkAnnual() {
    await until(() => {
      const ready = annualReady();
      for (const [phase, ok] of Object.entries(ready)) if (ok) timingsMs[phase] ??= elapsed();
      const missing = Object.keys(ready).find(phase => !ready[phase]);
      stage = missing || 'annual';
      return !missing;
    }, 'annual_value_or_phase_missing');
    stage = 'vodafone_panels';
    await until(() => fresh.has('panels'), 'panels_not_confirmed');
    for (const provider of ['vodafone','digi']) {
      stage = provider + '_trend';
      one('.activation-primary', card(provider)).click();
      const dialog = await until(() => one('[role="dialog"].monthly-sales-dialog'), 'trend_missing');
      const rows = [...dialog.querySelectorAll('tbody tr[data-month]')];
      const exactMonths = rows.map(row => row.dataset.month).join() === months.join();
      const close = dialog.querySelector('[data-slot="dialog-close"]');
      if (!close) fail('trend_close_missing');
      close.click();
      await until(() => !visible(dialog), 'trend_close_failed');
      if (!exactMonths) fail('trend_months_mismatch');
    }
  }
  async function checkBonus() {
    const panel = await until(() => one('.vodafone-bonus', report()), 'bonus_not_open');
    const table = await until(() => fresh.has('bonus') && one('table', panel), 'bonus_register_missing');
    if (one('select', panel)?.value !== months[0] ||
        !/^Raport final din \d{2}\.\d{2}\.\d{4} ·/.test(one('.commerce-source', panel)?.textContent || '')) fail('bonus_month_not_final');
    if (button(panel, 'Registru pe punct')?.getAttribute('aria-pressed') !== 'true' ||
        one('input[type="search"]', panel)?.value !== '') fail('bonus_view_mismatch');
    const headers = [...table.tHead.rows[0].cells].map(cell => cell.textContent);
    const columns = {sim0Bonus:headers.indexOf('Bonus SIM 0 calculat'), totalBonus:headers.indexOf('Total calculat')};
    if (Object.values(columns).includes(-1)) fail('bonus_column_missing');
    const rows = table.tBodies[0].rows;
    const empty = one('.commerce-empty', panel);
    if (!rows.length && empty?.textContent !== 'Niciun rezultat pentru selecția curentă.') fail('bonus_register_missing');
    timingsMs.bonusRegister = elapsed();
    for (;;) {
      const more = [...panel.querySelectorAll('button')].find(el => visible(el) && /^Arată încă \d+$/.test(el.textContent));
      if (!more) break;
      const before = rows.length;
      if (before >= expected.rows) fail('bonus_row_count_mismatch');
      more.click();
      await until(() => fresh.has('bonusFull') && rows.length > before, 'bonus_pagination_stalled');
    }
    // Match only the point code locally. Never return or log point/partner text.
    const matches = [...rows].filter(row => row.cells[0].querySelector('small')?.textContent.split(' · ')[0] === expected.pointCode);
    const values = {};
    if (matches.length === 1) {
      for (const [key,index] of Object.entries(columns)) {
        const cell = matches[0].cells[index];
        if (visible(cell)) values[key] = cell.textContent;
      }
    }
    const error = checkReference(expected, rows.length, matches.length, values);
    if (error) fail(error);
    timingsMs.bonusVerified = elapsed();
  }
  try {
    await checkIdentity();
    if (!annual && role !== 'manager') fail('manager_required');
    deadline = now() + timeoutMs;
    stage = 'selection';
    const prepay = await until(() => button(one('.main-nav'), 'Prepay'), 'prepay_missing');
    prepay.click();
    const tab = text => button(one('nav[aria-label="Prepay"]', workspace()), text);
    // Prepare the period away from either measured report. This avoids intermediate annual requests.
    (await until(() => tab('Verificare Sim'), 'prepay_missing')).click();
    await until(() => tab('Verificare Sim')?.getAttribute('aria-pressed') === 'true' && !report(), 'prepay_reset_failed');
    await until(picker, 'month_picker_missing');
    originalMonths = selection();
    await setPeriod(months);
    const activate = tab('Activări');
    if (!activate) fail('activation_access_missing');
    let trigger = activate;
    if (!annual) {
      activate.click();
      trigger = await until(() => button(report(), 'Bonusuri Vodafone'), 'bonus_control_missing');
    }
    window.addEventListener('mobiup-data-freshness', freshness);
    start = now();
    deadline = start + timeoutMs;
    stage = config.scenario;
    trigger.click();
    if (annual && role === 'agent') {
      await until(report, 'activation_access_missing');
      if (button(report(), 'Bonusuri Vodafone')) fail('agent_manager_control_visible');
    }
    if (annual) await checkAnnual();
    else await checkBonus();
    stage = 'postflight';
    await checkIdentity();
    if (selection().join() !== months.join()) fail('month_selection_mismatch');
    if (annual && !Object.values(annualReady()).every(Boolean)) fail('annual_values_changed');
    if (failure) fail(failure);
    let verified = 'annual_values_and_months';
    if (!annual) {
      const amounts = [expected.sim0Bonus, expected.totalBonus].filter(value => value !== undefined);
      verified = !expected.rows ? 'closed_empty' : amounts.every(value => value === 0) ? 'closed_zero_bonus' : 'closed_reference_row';
    }
    result = {outcome:'pass', verified, timingsMs, apiMs};
  } catch {
    result = {outcome:'error', stage, code:failure || 'browser_error', timingsMs, apiMs};
  } finally {
    window.removeEventListener('mobiup-data-freshness', freshness);
    if (start !== undefined) {
      for (const entry of performance.getEntriesByType('resource')) {
        if (entry.startTime < start || entry.responseStatus !== 200 || entry.initiatorType !== 'fetch') continue;
        const url = new URL(entry.name, origin), phase = phaseOf(url);
        if (phase && matchesScope(url.searchParams)) (apiMs[phase] ??= []).push(Math.round(entry.duration));
      }
    }
    if (originalMonths) {
      try {
        // Only restore this authenticated account's settings. Leave a switched session untouched.
        failure = undefined;
        await checkIdentity();
        if (selection().join() !== originalMonths.join()) {
          const neutral = button(one('nav[aria-label="Prepay"]', workspace()), 'Verificare Sim');
          if (neutral) neutral.click();
          deadline = now() + timeoutMs;
          await setPeriod(originalMonths);
        }
      } catch {
        if (result.outcome === 'pass') result = {outcome:'error', stage:'restore', code:'session_or_period_restore_failed', timingsMs, apiMs};
        else result.restore = 'session_or_period_restore_failed';
      }
    }
  }
  return result;
}
