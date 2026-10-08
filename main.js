(() => {
  'use strict';
  const helper = window.DeeplinkDemo;
  const $ = id => document.getElementById(id);
  const sessionId = crypto.randomUUID();
  const allowedRoutes = new Set(['/home', '/contracts/A', '/contracts/B']);
  const appliedIds = new Set();
  const awaitingAck = new Map();
  let ctx = null;
  let syncing = false;
  let resync = false;
  let stopped = false;
  let lastFailure = '';
  let lastAppliedId = '';

  function log(message) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString('ru-RU');
    li.append(time, document.createTextNode(message));
    $('log').prepend(li);
    while ($('log').children.length > 80) $('log').lastElementChild.remove();
  }
  function status(message, level = 'waiting') {
    $('status').textContent = message;
    $('status').dataset.level = level;
  }
  function foreground() {
    return document.visibilityState === 'visible' && (ctx && ctx.localDemo
      ? document.hasFocus() : !ctx || ctx.telegram.isActive !== false);
  }
  function updateForeground() {
    $('active-state').textContent = foreground() ? 'Основное приложение активно' : 'Ожидаем возврата в приложение';
  }
  function currentRoute() {
    const target = location.hash.slice(1);
    return allowedRoutes.has(target) ? target : '/home';
  }
  function renderRoute() {
    const route = currentRoute();
    const target = route.startsWith('/contracts/') ? route.split('/').pop() : '';
    $('route-view').dataset.contract = target;
    $('route-label').textContent = target ? 'Карточка контракта' : 'Главная страница';
    $('route-title').textContent = target ? `Контракт ${target}` : 'Готово к переходу';
    $('route-path').textContent = route;
    $('route-description').textContent = target
      ? `Цель ${target} открыта в сессии ${sessionId.slice(-8)}. Это демонстрационная карточка.`
      : 'Откройте ссылку A или B из сообщения Telegram.';
    document.querySelectorAll('[data-route]').forEach(button => {
      if (button.dataset.route === route) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }
  function navigate(route) {
    if (!allowedRoutes.has(route)) throw new Error('Недопустимый маршрут');
    if (location.hash !== `#${route}`) location.hash = route;
    renderRoute();
  }
  function reportFailure(error) {
    const message = String(error.message || error).slice(0, 220);
    status(message, 'error');
    if (message !== lastFailure) log(`Ошибка: ${message}`);
    lastFailure = message;
  }
  async function sync(reason = 'poll') {
    if (stopped || !ctx || !foreground()) return;
    updateForeground();
    if (syncing) { resync = true; return; }
    syncing = true;
    try {
      do {
        resync = false;
        const intent = await helper.pending();
        if (!foreground()) break;
        if (intent) {
          if (!['A', 'B'].includes(intent.target) || typeof intent.id !== 'string') throw new Error('Некорректная команда в хранилище');
          if (!appliedIds.has(intent.id)) {
            const route = `/contracts/${intent.target}`;
            navigate(route);
            await new Promise(resolve => requestAnimationFrame(resolve));
            if (!foreground()) break;
            lastAppliedId = intent.id;
            appliedIds.add(intent.id);
            awaitingAck.set(intent.id, intent);
            $('applied-seq').textContent = `…${intent.id.slice(-8)}`;
            log(`Переход ${route}, intent=${intent.id.slice(-8)}, источник=${reason}`);
          }
        }
        for (const [id, applied] of awaitingAck) {
          if (!foreground()) break;
          const acked = await helper.acknowledge(id);
          awaitingAck.delete(id);
          if (!acked) {
            log(`Intent ${id.slice(-8)} уже заменён более новым; старый ACK не записан`);
            resync = true;
            continue;
          }
          $('acked-seq').textContent = `…${id.slice(-8)}`;
          log(`ACK intent=${id.slice(-8)}: маршрут выполнен в этой сессии`);
          status(`Открыт контракт ${applied.target}. Выполнение маршрута подтверждено.`, 'success');
        }
        if (lastFailure) {
          log('Хранилище снова доступно');
          lastFailure = '';
          if (!awaitingAck.size) status(lastAppliedId ? 'Маршрут подтверждён. Ожидаем следующую ссылку.' : 'Приложение готово. Ожидаем ссылку из сообщения.', 'success');
        }
      } while (resync && foreground());
    } catch (error) { reportFailure(error); }
    finally { syncing = false; }
  }
  function copyButton(text) {
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = 'Скопировать';
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Скопировано';
        setTimeout(() => { button.textContent = 'Скопировать'; }, 1800);
      } catch (_) { status('Выделите и скопируйте ссылку вручную.', 'waiting'); }
    });
    return button;
  }
  function showLinks() {
    if (!ctx) return;
    $('links').replaceChildren();
    for (const target of ['A', 'B']) {
      const url = `https://t.me/${ctx.config.botUsername}/${ctx.config.launcherShortName}?startapp=${target}`;
      const item = document.createElement('div');
      item.className = 'link-item';
      const label = document.createElement('strong');
      label.textContent = `Контракт ${target}`;
      const code = document.createElement('code');
      code.className = 'link-code';
      code.textContent = url;
      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(copyButton(url));
      if (ctx.localDemo) {
        const link = document.createElement('a');
        link.className = 'primary';
        link.textContent = `Локально открыть ${target}`;
        link.href = `./go.html?target=${target}`;
        link.target = '_blank';
        // Same-origin local demo retains opener for focus without reloading main.
        actions.append(link);
      }
      item.append(label, code, actions);
      $('links').append(item);
    }
    status('Ссылки готовы. Используйте A и B для проверки.', 'success');
    log('Показаны ссылки A и B; внешних запросов не было');
  }
  function wake(reason) {
    updateForeground();
    log(`${reason}: ${foreground() ? 'foreground' : 'background'}`);
    if (foreground()) sync(reason);
  }

  $('session-id').textContent = sessionId;
  $('session-pill').textContent = `Сессия ${sessionId.slice(-8)}`;
  renderRoute();
  window.addEventListener('hashchange', renderRoute);
  document.querySelectorAll('[data-route]').forEach(button => button.addEventListener('click', () => {
    navigate(button.dataset.route);
    log(`Ручная навигация ${button.dataset.route}`);
  }));
  $('create-links').addEventListener('click', showLinks);
  window.addEventListener('focus', () => wake('focus'));
  window.addEventListener('blur', updateForeground);
  window.addEventListener('online', () => wake('online'));
  document.addEventListener('visibilitychange', () => wake('visibilitychange'));
  window.addEventListener('pagehide', () => { stopped = true; });
  window.addEventListener('pageshow', () => { stopped = false; sync('pageshow'); });
  (async () => {
    try {
      ctx = await helper.init();
      $('mode').textContent = ctx.localDemo ? 'OFFLINE DEMO · loopback' : `TELEGRAM · @${ctx.config.botUsername}`;
      $('platform').textContent = ctx.localDemo ? 'local browser' : ctx.telegram.platform;
      $('sdk-version').textContent = ctx.telegram.version;
      $('device-key').textContent = `…${ctx.deviceKey.slice(-10)}`;
      $('storage').textContent = ctx.localDemo ? 'localStorage · локальная симуляция' : 'Telegram DeviceStorage · API 9.0+';
      $('storage-note').hidden = false;
      $('storage-note').textContent = ctx.localDemo
        ? 'Локальные вкладки используют хранилище одного origin. Это проверяет обмен командой, но не фокусировку окон Telegram.'
        : 'DeviceStorage принадлежит боту, пользователю и устройству. /demo и /go используют один ключ. Запуск и фокус проверяются на клиентах Telegram.';
      $('demo-note').hidden = !ctx.localDemo;
      if (ctx.localDemo) {
        $('steps').replaceChildren();
        [
          'Покажите ссылки и нажмите «Локально открыть A»: launcher откроется в отдельной вкладке.',
          'В launcher нажмите «Вернуться в эту сессию»: существующая вкладка должна показать A с прежним идентификатором.',
          'Откройте B аналогично. Для холодного запуска используйте «Открыть новую сессию» и сравните идентификаторы.',
        ].forEach(text => { const li = document.createElement('li'); li.textContent = text; $('steps').append(li); });
      }
      ctx.telegram.ready();
      ctx.telegram.onEvent('activated', () => wake('activated'));
      ctx.telegram.onEvent('deactivated', () => wake('deactivated'));
      const launches = (Number(await ctx.store.get('main-launches')) || 0) + 1;
      await ctx.store.set('main-launches', launches);
      $('launch-count').textContent = `${launches} · хранилище устройства`;
      $('create-links').disabled = false;
      updateForeground();
      log(`Новый документ main: сессия ${sessionId.slice(-8)}`);
      status('Приложение готово. Ожидаем ссылку из сообщения.', 'success');
      await sync('cold-start');
      setInterval(() => sync('poll'), 1000);
    } catch (error) { reportFailure(error); }
  })();
})();
