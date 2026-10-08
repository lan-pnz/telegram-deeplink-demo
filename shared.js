(function () {
  'use strict';

  const prefix = 'tonhr_deeplink_demo_v1_';
  const ttl = 10 * 60 * 1000;
  let context;
  let initialization;
  const clicks = new Map();
  const storageNoticeListeners = new Set();
  const storageReadbackNotice = 'DeviceStorage: ACK записи не получен; сохранение подтверждено чтением.';

  class DeviceStorageTimeoutError extends Error {
    constructor(method, env) {
      super(`DeviceStorage.${method} не ответил за 5 секунд. Платформа: ${env.platform}; API: ${env.apiVersion}; канал: ${env.transport}.`);
      this.name = 'DeviceStorageTimeoutError';
    }
  }

  function onStorageNotice(callback) {
    if (typeof callback !== 'function') throw new TypeError('Ожидается обработчик уведомления хранилища.');
    storageNoticeListeners.add(callback);
    return () => storageNoticeListeners.delete(callback);
  }

  function notifyStorageReadback() {
    for (const callback of [...storageNoticeListeners]) {
      try { callback(storageReadbackNotice); }
      catch (_) {}
    }
  }

  function environment() {
    const telegram = window.Telegram && window.Telegram.WebApp;
    const localDemo = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
      && !(telegram && telegram.initData);
    let transport = 'не найден';
    try {
      if (window.TelegramWebviewProxy && typeof window.TelegramWebviewProxy.postEvent === 'function') transport = 'TelegramWebviewProxy';
      else if (window.external && typeof window.external.notify === 'function') transport = 'external.notify';
      else if (window.parent != null && window.parent !== window) transport = 'iframe';
    } catch (_) {}
    return {
      localDemo,
      platform: localDemo ? 'local browser' : String(telegram && telegram.platform || 'unknown').slice(0, 32),
      apiVersion: String(telegram && telegram.version || 'unknown').slice(0, 16),
      transport: localDemo ? 'локальная симуляция' : transport,
      telegramContext: !!(telegram && telegram.initData),
    };
  }

  function nativeCall(storage, method, ...args) {
    return new Promise((resolve, reject) => {
      const env = environment();
      const timer = setTimeout(() => reject(new DeviceStorageTimeoutError(method, env)), 5000);
      try {
        storage[method](...args, (error, value) => {
          clearTimeout(timer);
          if (error) reject(new Error(String(error)));
          else resolve(value);
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async function init() {
    if (initialization) return initialization;
    initialization = (async () => {
      const response = await fetch('./config.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Не удалось прочитать config.json.');
      const config = await response.json();
      if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(config.botUsername)
          || !/^[A-Za-z0-9_]{1,64}$/.test(config.launcherShortName)
          || (config.mainAppShortName && !/^[A-Za-z0-9_]{1,64}$/.test(config.mainAppShortName))) {
        throw new Error('Некорректная конфигурация Telegram-приложений.');
      }
      const telegram = window.Telegram && window.Telegram.WebApp;
      const localDemo = environment().localDemo;
      let storage;
      if (localDemo) {
        storage = {
          async get(key) { return window.localStorage.getItem(prefix + key); },
          async set(key, value) { window.localStorage.setItem(prefix + key, value); },
        };
      } else {
        if (!telegram || !telegram.initData) throw new Error('Откройте пример как Mini App внутри Telegram.');
        if (!telegram.isVersionAtLeast('9.0') || !telegram.DeviceStorage) {
          throw new Error('Для статического примера нужен Telegram с DeviceStorage (Bot API 9.0+).');
        }
        // The interface is already rendered; readiness must not depend on storage responding.
        telegram.ready();
        storage = {
          async get(key) { return nativeCall(telegram.DeviceStorage, 'getItem', prefix + key); },
          async set(key, value) {
            const fullKey = prefix + key;
            try {
              const stored = await nativeCall(telegram.DeviceStorage, 'setItem', fullKey, value);
              if (stored !== true) throw new Error('Telegram не подтвердил сохранение команды.');
            } catch (error) {
              if (!(error instanceof DeviceStorageTimeoutError)) throw error;
              // A missing callback does not prove that the native write failed.
              // Confirm the exact payload with one read; never repeat the mutation.
              const readback = await nativeCall(telegram.DeviceStorage, 'getItem', fullKey);
              if (readback !== value) throw error;
              notifyStorageReadback();
            }
          },
        };
      }
      const store = {
        async get(key) {
          const raw = await storage.get(key);
          if (raw === null || raw === undefined || raw === '') return null;
          try { return JSON.parse(raw); }
          catch (_) { throw new Error('В хранилище примера повреждённые данные.'); }
        },
        async set(key, value) { await storage.set(key, JSON.stringify(value)); },
      };
      let deviceKey = await store.get('device');
      if (typeof deviceKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(deviceKey)) {
        deviceKey = crypto.randomUUID();
        await store.set('device', deviceKey);
      }
      const base = 'https://t.me/' + config.botUsername;
      const mainAppUrl = base + (config.mainAppShortName ? '/' + config.mainAppShortName : '') + '?startapp';
      context = { telegram, config, store, deviceKey, localDemo, mainAppUrl };
      return context;
    })();
    try { return await initialization; }
    catch (error) { initialization = undefined; throw error; }
  }

  function validIntent(value) {
    return value && typeof value === 'object'
      && typeof value.id === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value.id)
      && ['A', 'B'].includes(value.target)
      && value.deviceKey === context.deviceKey
      && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt);
  }

  async function activate(target, clickId) {
    await init();
    if (!['A', 'B'].includes(target)) throw new Error('Допустимы только тестовые экраны A и B.');
    if (typeof clickId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(clickId)) {
      throw new Error('Некорректный ID нажатия.');
    }
    let candidate = clicks.get(clickId);
    if (candidate && candidate.target !== target) throw new Error('Этот ID нажатия уже использован для другого экрана.');
    if (!candidate) {
      candidate = { id: clickId, target, createdAt: Date.now(), deviceKey: context.deviceKey };
      clicks.set(clickId, candidate);
    }
    const current = await context.store.get('pending');
    if (validIntent(current) && current.id === candidate.id) {
      if (current.target !== target) throw new Error('Этот ID нажатия уже использован для другого экрана.');
      return current;
    }
    if (validIntent(current) && current.createdAt > candidate.createdAt) {
      throw new Error('Уже поступило более новое нажатие. Используйте последнюю ссылку.');
    }
    await context.store.set('pending', candidate);
    return candidate;
  }

  async function pending() {
    await init();
    const intent = await context.store.get('pending');
    if (!validIntent(intent)) return null;
    const age = Date.now() - intent.createdAt;
    if (age > ttl || age < -30000) return null;
    if ((await receipt(intent.id)).acknowledged) return null;
    return intent;
  }

  async function acknowledge(id) {
    await init();
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw new Error('Некорректный ID команды.');
    const intent = await context.store.get('pending');
    if (!validIntent(intent) || intent.id !== id) return false;
    await context.store.set('receipt_' + id, { id, appliedAt: Date.now(), deviceKey: context.deviceKey });
    return true;
  }

  async function receipt(id) {
    await init();
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw new Error('Некорректный ID команды.');
    const value = await context.store.get('receipt_' + id);
    return { acknowledged: !!value && value.id === id && value.deviceKey === context.deviceKey };
  }

  window.DeeplinkDemo = { environment, onStorageNotice, init, activate, pending, acknowledge, receipt };
})();
