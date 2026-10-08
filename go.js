(() => {
  'use strict';
  const helper = window.DeeplinkDemo;
  const $ = id => document.getElementById(id);
  const clickId = helper.createId();
  let ctx = null;
  let intent = null;
  let activating = false;
  let checking = false;
  let receiptTask = null;
  let acknowledged = false;
  let waitingSince = 0;
  let timer = null;
  let lastFailure = '';
  let openingRequested = false;
  let closeRequested = false;
  let nativeHandlersAttached = false;
  let environmentLogged = false;

  function log(message) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString('ru-RU');
    li.append(time, document.createTextNode(message));
    $('log').prepend(li);
    while ($('log').children.length > 60) $('log').lastElementChild.remove();
  }
  helper.onStorageNotice(log);
  function stage(title, message, error = false) {
    $('stage').textContent = title;
    $('message').textContent = message;
    $('indicator').dataset.error = String(error);
  }
  function reportFailure(error) {
    const message = String(error.message || error).slice(0, 240);
    stage(intent ? 'Цель сохранена, ждём подтверждение' : 'Переход не сохранён', message, true);
    if (message !== lastFailure) log(`Ошибка: ${message}`);
    lastFailure = message;
    if (!intent) $('retry').hidden = false;
  }
  function hasOpener() {
    try { return !!window.opener && !window.opener.closed && window.opener.location.origin === location.origin; }
    catch (_) { return false; }
  }
  function showActions() {
    if (ctx.localDemo) {
      $('resume-main').hidden = !hasOpener();
      $('new-main').hidden = false;
      $('new-main').href = new URL('./index.html', location.href).href;
    } else $('open-main').hidden = false;
  }
  function stopReceiptPolling() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function canCheckReceipt() {
    return ctx && intent && !acknowledged && !closeRequested
      && (ctx.localDemo || openingRequested);
  }
  function scheduleReceiptPoll() {
    if (!canCheckReceipt() || timer !== null) return;
    const delay = Date.now() - waitingSince < 3000 ? 50 : 1200;
    timer = setTimeout(async () => {
      timer = null;
      await checkReceipt();
      scheduleReceiptPoll();
    }, delay);
  }
  async function restartReceiptPolling() {
    await checkReceipt();
    scheduleReceiptPoll();
  }
  function closeLauncher(reason) {
    if (!ctx || ctx.localDemo || !intent || closeRequested) return;
    if (!acknowledged && !openingRequested) return;
    closeRequested = true;
    stopReceiptPolling();
    log(`Запрошено закрытие launcher: ${reason}`);
    try {
      ctx.telegram.close();
    } catch (error) {
      closeRequested = false;
      reportFailure(error);
    }
  }
  function onDeactivated() {
    if (!intent || !openingRequested || acknowledged || closeRequested) return;
    stage('Команда сохранена, launcher деактивирован', 'Закрываем launcher после сигнала deactivated. Выполнение маршрута и нативный фокус этим сигналом не подтверждаются.');
    closeLauncher('deactivated после сохранения цели и запроса открытия main');
  }
  function openMain(restartPolling = true, userGesture = false) {
    if (!intent || acknowledged || closeRequested) return false;
    stopReceiptPolling();
    try {
      const url = new URL(ctx.mainAppUrl);
      if (url.protocol !== 'https:' || url.hostname !== 't.me') throw new Error('Недопустимый URL основного приложения');
      // Attach the native handler in activate() first: Telegram can emit deactivated synchronously.
      openingRequested = true;
      if (ctx.telegram.platform === 'android' && !userGesture) {
        // Android's SDK handler ignores automatic opens without a recent WebView tap.
        // Ordinary t.me navigation follows its internal-link handler instead.
        log('Запрашиваем main обычным переходом по Telegram-ссылке; native ACK отсутствует');
        location.assign(url.href);
      } else {
        log('Запрашиваем main через openTelegramLink; native ACK отсутствует');
        ctx.telegram.openTelegramLink(url.href);
      }
      waitingSince = Date.now();
      if (closeRequested) return true;
      stage('Ожидаем основное приложение', 'Цель сохранена. Команда открытия отправлена Telegram; ждём подтверждение выполненного маршрута.');
      if (restartPolling) restartReceiptPolling();
      return true;
    } catch (error) {
      openingRequested = false;
      reportFailure(error);
      return false;
    }
  }
  function checkReceipt() {
    if (!canCheckReceipt()) return Promise.resolve();
    if (checking) return receiptTask;
    checking = true;
    receiptTask = (async () => {
      try {
        const receipt = await helper.receipt(intent.id);
        if (receipt && receipt.acknowledged) {
          acknowledged = true;
          stopReceiptPolling();
          $('receipt').textContent = 'ACK получен';
          $('title').textContent = 'Страница открыта';
          $('indicator').dataset.finished = 'true';
          stage('Маршрут подтверждён', `Контракт ${intent.target} открыт в видимом основном приложении. Launcher можно закрыть.`);
          log(`ACK intent=${intent.id.slice(-8)}`);
          $('open-main').hidden = true;
          $('retry').hidden = true;
          if (ctx.localDemo) window.close();
          else closeLauncher('ACK выполненного маршрута');
        } else {
          if (lastFailure) { log('Хранилище снова доступно'); lastFailure = ''; }
          if (waitingSince && Date.now() - waitingSince > 12000) {
            stage('Подтверждение пока не получено', ctx.localDemo
              ? 'Переключитесь в основное приложение: существующая сессия проверяется кнопкой возврата, холодный запуск — новой сессией.'
              : 'Повторите открытие основного приложения. Цель уже сохранена, повторный intent не создаётся. Ожидание ACK не доказывает отсутствие фокуса.');
            showActions();
          }
        }
      } catch (error) { reportFailure(error); }
      finally { checking = false; receiptTask = null; }
    })();
    return receiptTask;
  }
  async function activate() {
    if (activating || acknowledged) return;
    if (intent) { if (!ctx.localDemo) openMain(true, true); return; }
    activating = true;
    $('retry').disabled = true;
    try {
      const env = helper.environment();
      $('mode').textContent = env.localDemo ? 'OFFLINE DEMO · loopback' : (env.telegramContext ? 'TELEGRAM' : 'ВНЕ TELEGRAM');
      $('platform').textContent = `${env.platform} / ${env.apiVersion}`;
      $('sdk-transport').textContent = env.transport;
      $('storage').textContent = env.localDemo ? 'localStorage · локальная симуляция' : 'DeviceStorage · проверяем ответ';
      if (!environmentLogged) {
        log(`Среда: ${env.platform}; API=${env.apiVersion}; канал=${env.transport}; сборка=smooth-transitions-6`);
        environmentLogged = true;
      }
      if (!ctx) ctx = await helper.init();
      if (!nativeHandlersAttached) {
        ctx.telegram.onEvent('deactivated', onDeactivated);
        ctx.telegram.onEvent('activated', checkReceipt);
        nativeHandlersAttached = true;
      }
      const param = ctx.localDemo ? new URLSearchParams(location.search).get('target') : ctx.telegram.initDataUnsafe.start_param;
      const target = ['A', 'B'].includes(param) ? param : '';
      if (!target) throw new Error(ctx.localDemo ? 'Нет цели A/B. Откройте локальную ссылку из main.' : `Откройте /${ctx.config.launcherShortName}?startapp=A или /${ctx.config.launcherShortName}?startapp=B через Telegram.`);
      $('title').textContent = `Открываем контракт ${target}`;
      $('mode').textContent = ctx.localDemo ? 'OFFLINE DEMO · loopback' : `TELEGRAM · @${ctx.config.botUsername}`;
      $('platform').textContent = `${ctx.telegram.platform} / ${ctx.telegram.version}`;
      $('storage').textContent = ctx.localDemo ? 'localStorage · локальная симуляция' : 'Telegram DeviceStorage · API 9.0+';
      $('device-key').textContent = `…${ctx.deviceKey.slice(-10)}`;
      $('storage-note').hidden = false;
      $('storage-note').textContent = ctx.localDemo
        ? 'Локальный браузер проверяет обмен командой; фокусировка вкладок не моделирует клиентов Telegram.'
        : 'Команда A/B в DeviceStorage не предоставляет доступ к данным и не заменяет серверную авторизацию.';
      if (ctx.localDemo) ctx.telegram.ready();
      stage('Сохраняем цель перехода', 'Повторная попытка использует тот же clickId документа.');
      intent = await helper.activate(target, clickId);
      if (!intent || !['A', 'B'].includes(intent.target) || typeof intent.id !== 'string') throw new Error('Хранилище вернуло некорректную команду');
      $('target').textContent = `Контракт ${intent.target} · intent=${intent.id.slice(-8)}`;
      $('retry').hidden = true;
      waitingSince = Date.now();
      log(`Цель сохранена: ${intent.target}, intent=${intent.id.slice(-8)}`);
      showActions();
      if (ctx.localDemo) stage('Цель готова к переходу', hasOpener()
        ? 'Вернитесь в эту сессию без перезагрузки или откройте новую для холодного запуска.'
        : 'Откройте новую сессию. Браузер может блокировать автоматические popup после асинхронного запроса.');
      else if (!openMain(false)) return;
      await checkReceipt();
      scheduleReceiptPoll();
    } catch (error) { reportFailure(error); }
    finally { activating = false; $('retry').disabled = false; }
  }

  $('click-id').textContent = `…${clickId.slice(-10)}`;
  $('retry').addEventListener('click', activate);
  $('open-main').addEventListener('click', () => openMain(true, true));
  $('resume-main').addEventListener('click', () => {
    if (hasOpener()) {
      window.opener.focus();
      log('Запрошен фокус существующей вкладки без перезагрузки');
      $('message').textContent = 'Если браузер не переключил вкладку, перейдите в неё вручную. Сессия main должна остаться прежней.';
    } else {
      $('resume-main').hidden = true;
      $('message').textContent = 'Предыдущая вкладка закрыта. Откройте новую сессию.';
    }
  });
  window.addEventListener('focus', checkReceipt);
  window.addEventListener('online', checkReceipt);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkReceipt(); });
  activate();
})();
