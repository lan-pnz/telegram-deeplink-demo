# Telegram deeplink demo for GitHub Pages

Статический пример для `@my_super_super_puper_test_bot`. Два именованных
Mini App одного бота: основное `demo` и вспомогательное `go`.
Bot token этому сайту не нужен; в GitHub его загружать не требуется.

`go.html` сохраняет новый intent в Telegram DeviceStorage, открывает `demo`
через openTelegramLink. После сохранения команды launcher закрывается при
native событии `deactivated` после запроса открытия либо после ACK маршрута.
`index.html` читает
intent при старте, активации, восстановлении связи и polling, показывает
тестовый экран A/B и записывает ACK. DeviceStorage локален для пользователя,
устройства и бота. Требуется Telegram с поддержкой Bot API 9.0+.

## GitHub Pages

1. Создать репозиторий `telegram-deeplink-demo`.
2. Загрузить **содержимое этой папки** в корень default branch репозитория.
3. Settings → Pages: настроить публикацию из корня default branch.
4. После публикации адрес примера: `https://<owner>.github.io/telegram-deeplink-demo/`.
5. В BotFather создать именованный Mini App `demo` с URL
   `https://<owner>.github.io/telegram-deeplink-demo/index.html`.
6. Создать именованный Mini App `go` с URL
   `https://<owner>.github.io/telegram-deeplink-demo/go.html`.
7. Если short names отличаются, изменить `config.json` и опубликовать его.

Основной пример открывается ссылкой:

```text
https://t.me/my_super_super_puper_test_bot/demo?startapp
```

Тестовые ссылки в сообщениях:

```text
https://t.me/my_super_super_puper_test_bot/go?startapp=A
https://t.me/my_super_super_puper_test_bot/go?startapp=B
```

Текущий Main Mini App бота менять не требуется: пример использует именованный `demo`.
URL страницы `go.html` и Telegram short name `go` — разные настройки.

## Как проверить

1. При закрытом `demo` нажать A: должен открыться экран A.
2. Перейти на главную, свернуть `demo`, нажать ту же ссылку A.
3. При открытом `demo` нажать B: должен появиться экран B.
4. Нажать старую ссылку A: новый intent должен вернуть экран A.
5. Обычное раскрытие без ссылки не должно повторять подтверждённый переход.
6. Записать платформу, версию Telegram, IDs документов и intents из журнала.

Сравнить deviceKey в `go` и `demo`. Проверка на Android, iOS и Desktop нужна
для подтверждения отдельных жизненных циклов Mini Apps, открытия/фокуса main
и автоматического закрытия launcher. Сам факт записи intent не доказывает
успешное переключение Telegram.

Если `/go` остался открытым и Telegram восстановил его старый документ, новое
нажатие ссылки может не выполнить launcher. Журнал ID документов позволяет
обнаружить это. Это ключевое проверяемое ограничение схемы.

Закрытие на `deactivated` добавлено, потому что фоновые WebView на мобильных
устройствах могут приостанавливать JS и не дождаться ACK. Это сигнал потери
активности, а не подтверждение успешного открытия main. Команда уже сохранена;
поведение нативных окон при закрытии launcher нужно проверить отдельно.

Статический пример содержит только открытые тестовые экраны A/B. Он не
заменяет backend-аутентификацию, проверку доступа к договорам и серверное
хранилище команд в TON HR. Одновременные клики/несколько launcher не имеют
серверного атомарного упорядочивания. Для устройств без DeviceStorage нужен
отдельный вариант с backend; в этот статический репозиторий он не входит.

## Локальный preview

```sh
python3 -m http.server 8766 --bind 127.0.0.1
```

Открыть `http://127.0.0.1:8766/index.html`. Только на loopback без Telegram
включается симуляция через browser localStorage. Она проверяет JS-протокол,
но не native DeviceStorage или Telegram WebView.

Официальные источники:

- [Telegram DeviceStorage](https://core.telegram.org/bots/webapps#devicestorage)
- [Direct Mini App links](https://core.telegram.org/api/links#direct-mini-app-links)
- [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [HTTPS в GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)
