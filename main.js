(() => {
  'use strict';
  const helper = window.DeeplinkDemo;
  const $ = id => document.getElementById(id);
  const sessionId = helper.createId();
  const allowedRoutes = new Set(['/home', '/contracts/A', '/contracts/B']);
  const preparedIds = new Set();
  const preparingIds = new Set();
  let ctx = null;
  let syncing = false;
  let resync = false;
  let stopped = false;
  let lastFailure = '';
  let renderedRoute = null;
  let routeRevision = 0;
  let lastPreparedId = '';
  let currentIntent = null;
  let confirming = false;
  let activeConfirmation = null;
  let queuedConfirmation = null;
  let cancelVisibleFrame = null;
  let preparationTimer = null;
  let fastPreparationUntil = 0;

  function log(message) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString('ru-RU');
    li.append(time, document.createTextNode(message));
    $('log').prepend(li);
    while ($('log').children.length > 80) $('log').lastElementChild.remove();
  }
  helper.onStorageNotice(log);
  async function updateLaunchCount() {
    try {
      const launches = (Number(await ctx.store.get('main-launches')) || 0) + 1;
      await ctx.store.set('main-launches', launches);
      $('launch-count').textContent = `${launches} · хранилище устройства`;
    } catch (error) {
      $('launch-count').textContent = 'Недоступен';
      log(`Счётчик запусков не обновлён: ${String(error.message || error).slice(0, 220)}`);
    }
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
    if (route === renderedRoute) return;
    if (cancelVisibleFrame) cancelVisibleFrame();
    routeRevision += 1;
    const target = route.startsWith('/contracts/') ? route.split('/').pop() : '';
    $('route-view').dataset.contract = target;
    $('route-label').textContent = target ? 'Карточка контракта' : 'Главная страница';
    $('route-title').textContent = target ? `Контракт ${target}` : 'Готово к переходу';
    $('route-path').textContent = route;
    $('route-description').textContent = target
      ? `Тестовая карточка ${target} в сессии ${sessionId.slice(-8)}.`
      : 'Откройте ссылку A или B из сообщения Telegram.';
    $('route-content').hidden = false;
    $('route-loading').hidden = true;
    $('route-view').setAttribute('aria-busy', 'false');
    document.querySelectorAll('[data-route]').forEach(button => {
      if (button.dataset.route === route) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    renderedRoute = route;
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
  function prepareInBackground(intent) {
    if (preparedIds.has(intent.id) || preparingIds.has(intent.id)) return;
    preparingIds.add(intent.id);
    // A slow marker write must not block activation or another navigation.
    helper.markPrepared(intent.id, sessionId).then(prepared => {
      if (!prepared) return;
      preparedIds.add(intent.id);
      log(`Подготовка в фоне: ${intent.target}, intent=${intent.id.slice(-8)}. Показ ещё не подтверждён.`);
    }).catch(error => {
      log(`Подготовка не подтверждена: ${String(error.message || error).slice(0, 180)}`);
    }).finally(() => preparingIds.delete(intent.id));
  }
  function visibleFrame() {
    if (!foreground() || stopped) return Promise.resolve(false);
    return new Promise(resolve => {
      let finished = false;
      let frameId;
      const timer = setTimeout(() => finish(false), 250);
      function finish(visible) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (typeof cancelAnimationFrame === 'function' && frameId !== undefined) cancelAnimationFrame(frameId);
        cancelVisibleFrame = null;
        resolve(visible);
      }
      cancelVisibleFrame = () => finish(false);
      frameId = requestAnimationFrame(() => finish(!stopped && foreground()));
    });
  }
  function confirmationIsCurrent(job) {
    return !stopped && foreground() && currentIntent && currentIntent.id === job.intent.id
      && currentIntent.target === job.intent.target && routeRevision === job.revision
      && currentRoute() === job.route && renderedRoute === job.route;
  }
  function queueConfirmation(intent) {
    if (stopped || !foreground() || currentRoute() !== `/contracts/${intent.target}`) return;
    const job = { intent, route: `/contracts/${intent.target}`, revision: routeRevision };
    if (activeConfirmation && activeConfirmation.intent.id === intent.id
      && activeConfirmation.revision === job.revision) return;
    // Only the newest route waits behind a slow native receipt write.
    queuedConfirmation = job;
    confirmVisible();
  }
  async function confirmVisible() {
    if (confirming || stopped || !foreground()) return;
    confirming = true;
    try {
      while (queuedConfirmation && !stopped && foreground()) {
        const job = queuedConfirmation;
        queuedConfirmation = null;
        activeConfirmation = job;
        try {
          if (!confirmationIsCurrent(job) || !await visibleFrame() || !confirmationIsCurrent(job)) continue;
          const latest = await helper.pending();
          if (!confirmationIsCurrent(job)) continue;
          if (!latest || latest.id !== job.intent.id || latest.target !== job.intent.target) {
            sync('ack-refresh');
            continue;
          }
          const acked = await helper.acknowledge(job.intent.id);
          if (!acked) {
            log(`Intent ${job.intent.id.slice(-8)} уже заменён более новым; старый ACK не записан`);
            if (confirmationIsCurrent(job)) sync('ack-refresh');
            continue;
          }
          log(`ACK intent=${job.intent.id.slice(-8)}: маршрут выполнен в этой сессии`);
          // The route can change while an ACK is persisted. Its completion must
          // never replace the newer card's status or trigger another render.
          if (!confirmationIsCurrent(job)) continue;
          $('acked-seq').textContent = `…${job.intent.id.slice(-8)}`;
          status(`Открыт контракт ${job.intent.target}. Выполнение маршрута подтверждено.`, 'success');
          if (lastFailure) { log('Хранилище снова доступно'); lastFailure = ''; }
        } catch (error) {
          if (confirmationIsCurrent(job)) reportFailure(error);
          else log(`Подтверждение старого маршрута не завершено: ${String(error.message || error).slice(0, 180)}`);
        } finally { activeConfirmation = null; }
      }
    } finally {
      confirming = false;
      if (queuedConfirmation && !stopped && foreground()) confirmVisible();
    }
  }
  function stopPreparationPolling() {
    if (preparationTimer !== null) clearTimeout(preparationTimer);
    preparationTimer = null;
  }
  function schedulePreparationPoll() {
    if (preparationTimer !== null || stopped || foreground() || Date.now() >= fastPreparationUntil) return;
    preparationTimer = setTimeout(() => {
      preparationTimer = null;
      sync('background-poll');
      schedulePreparationPoll();
    }, 100);
  }
  async function sync(reason = 'poll') {
    if (stopped || !ctx) return;
    updateForeground();
    if (syncing) { resync = true; return; }
    syncing = true;
    try {
      do {
        resync = false;
        const intent = await helper.pending();
        if (stopped) break;
        if (!intent) {
          if (renderedRoute === null) renderRoute();
          break;
        }
        if (!['A', 'B'].includes(intent.target) || typeof intent.id !== 'string') throw new Error('Некорректная команда в хранилище');
        const route = `/contracts/${intent.target}`;
        currentIntent = intent;
        // A new message has a new ID. Polling an already applied command must
        // not undo a manual tab change while its ACK is still being persisted.
        if (lastPreparedId !== intent.id || renderedRoute === null) {
          navigate(route);
          lastPreparedId = intent.id;
          $('applied-seq').textContent = `…${intent.id.slice(-8)}`;
          log(`Состояние ${route}, intent=${intent.id.slice(-8)}, источник=${reason}`);
          if (foreground()) status(`Открыт контракт ${intent.target}. Подтверждаем показ страницы.`);
        }
        if (!foreground()) {
          if (currentRoute() === route) {
            prepareInBackground(intent);
            status(`Подготовлен контракт ${intent.target}. Ожидаем активации приложения.`);
          }
          break;
        }
        queueConfirmation(intent);
      } while (resync && !stopped);
    } catch (error) { reportFailure(error); }
    finally {
      syncing = false;
      if (resync && !stopped) sync('queued');
    }
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
    if (foreground()) stopPreparationPolling();
    else {
      if (cancelVisibleFrame) cancelVisibleFrame();
      fastPreparationUntil = Date.now() + 3000;
      schedulePreparationPoll();
    }
    sync(reason);
  }

  $('session-id').textContent = sessionId;
  $('session-pill').textContent = `Сессия ${sessionId.slice(-8)}`;
  window.addEventListener('hashchange', renderRoute);
  document.querySelectorAll('[data-route]').forEach(button => button.addEventListener('click', () => {
    navigate(button.dataset.route);
    const target = button.dataset.route.split('/').pop();
    status(target === 'home' ? 'Открыта главная страница.' : `Открыт контракт ${target}.`, 'success');
    log(`Ручная навигация ${button.dataset.route}`);
  }));
  $('create-links').addEventListener('click', showLinks);
  window.addEventListener('focus', () => wake('focus'));
  window.addEventListener('blur', () => wake('blur'));
  window.addEventListener('online', () => wake('online'));
  document.addEventListener('visibilitychange', () => wake('visibilitychange'));
  window.addEventListener('pagehide', () => {
    stopped = true;
    stopPreparationPolling();
    if (cancelVisibleFrame) cancelVisibleFrame();
  });
  window.addEventListener('pageshow', () => { stopped = false; sync('pageshow'); });
  (async () => {
    try {
      const env = helper.environment();
      $('mode').textContent = env.localDemo ? 'OFFLINE DEMO · loopback' : (env.telegramContext ? 'TELEGRAM' : 'ВНЕ TELEGRAM');
      $('platform').textContent = env.platform;
      $('sdk-version').textContent = env.apiVersion;
      $('sdk-transport').textContent = env.transport;
      $('storage').textContent = env.localDemo ? 'localStorage · локальная симуляция' : 'DeviceStorage · проверяем ответ';
      log(`Среда: ${env.platform}; API=${env.apiVersion}; канал=${env.transport}; сборка=instant-navigation-8`);
      ctx = await helper.init();
      $('mode').textContent = ctx.localDemo ? 'OFFLINE DEMO · loopback' : `TELEGRAM · @${ctx.config.botUsername}`;
      $('platform').textContent = ctx.localDemo ? 'local browser' : ctx.telegram.platform;
      $('sdk-version').textContent = ctx.telegram.version;
      $('device-key').textContent = `…${ctx.deviceKey.slice(-10)}`;
      $('storage').textContent = ctx.localDemo ? 'localStorage · локальная симуляция' : 'Telegram DeviceStorage · API 9.0+';
      $('storage-note').hidden = false;
      $('storage-note').textContent = ctx.localDemo
        ? 'Локальные вкладки используют хранилище одного origin. Это проверяет обмен командой, но не фокусировку окон Telegram.'
        : `DeviceStorage принадлежит боту, пользователю и устройству. ${ctx.config.mainAppShortName ? '/' + ctx.config.mainAppShortName : 'Main App'} и /${ctx.config.launcherShortName} используют один ключ. Запуск и фокус проверяются на клиентах Telegram.`;
      $('demo-note').hidden = !ctx.localDemo;
      if (ctx.localDemo) {
        $('steps').replaceChildren();
        [
          'Покажите ссылки и нажмите «Локально открыть A»: launcher откроется в отдельной вкладке.',
          'В launcher нажмите «Вернуться в эту сессию»: существующая вкладка должна показать A с прежним идентификатором.',
          'Откройте B аналогично. Для холодного запуска используйте «Открыть новую сессию» и сравните идентификаторы.',
        ].forEach(text => { const li = document.createElement('li'); li.textContent = text; $('steps').append(li); });
      }
      if (ctx.localDemo) ctx.telegram.ready();
      ctx.telegram.onEvent('activated', () => wake('activated'));
      ctx.telegram.onEvent('deactivated', () => wake('deactivated'));
      $('create-links').disabled = false;
      updateForeground();
      log(`Новый документ main: сессия ${sessionId.slice(-8)}`);
      status('Приложение готово. Ожидаем ссылку из сообщения.', 'success');
      await sync('cold-start');
      // Begin diagnostics only after the first target is read and rendered;
      // the counter itself never gates polling or visible confirmation.
      updateLaunchCount();
      setInterval(() => sync('poll'), 1000);
    } catch (error) { reportFailure(error); }
  })();
})();
