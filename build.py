"""Build the static demo pages without runtime script/config downloads."""
from pathlib import Path
import json
import re

BASE = Path(__file__).resolve().parent
VERSION = 'instant-navigation-8'


def build():
    config = json.loads((BASE / 'config.json').read_text())
    if set(config) != {'botUsername', 'mainAppShortName', 'launcherShortName'}:
        raise ValueError('Only the three public demo configuration fields are allowed')
    if not all(isinstance(value, str) for value in config.values()) or not (
        re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{4,31}', config['botUsername'])
        and re.fullmatch(r'[A-Za-z0-9_]{1,64}', config['launcherShortName'])
        and (not config['mainAppShortName'] or re.fullmatch(r'[A-Za-z0-9_]{1,64}', config['mainAppShortName']))
    ):
        raise ValueError('Invalid public Telegram configuration')
    config_json = json.dumps(config, ensure_ascii=False, separators=(',', ':'))
    results = []
    for page, entry in (('index.html', 'main.js'), ('go.html', 'go.js')):
        path = BASE / page
        html = path.read_text()
        html, count = re.subn(
            r'(<script id="demo-config" type="application/json">).*?(</script>)',
            lambda match: match[1] + config_json + match[2], html, flags=re.S,
        )
        if count != 1:
            raise ValueError('Expected one public config block in ' + page)
        sources = []
        for name in ('telegram-web-app.js', 'shared.js', entry):
            source = (BASE / name).read_text()
            if '</script' in source.lower():
                raise ValueError('Script contains an unsafe HTML closing tag: ' + name)
            sources.append('// ' + name + '\n' + source)
        bundle = '<script data-demo-bundle="' + VERSION + '">\n' + '\n;\n'.join(sources) + '\n</script>'
        html = re.sub(r'\s*<script(?: defer)? src="\./(?:telegram-web-app|shared)\.js(?:\?[^\"]*)?"></script>', '', html)
        if 'data-demo-bundle=' in html:
            html, count = re.subn(r'<script data-demo-bundle="[^\"]+">.*?</script>', lambda _: bundle, html, flags=re.S)
        else:
            pattern = r'<script(?: defer)? src="\./' + re.escape(entry) + r'(?:\?[^\"]*)?"></script>'
            html, count = re.subn(pattern, lambda _: bundle, html)
        if count != 1:
            raise ValueError('Expected one entry script in ' + page)
        if re.search(r'<script\b[^>]*\bsrc\s*=', html, re.I):
            raise ValueError('Unexpected external script in ' + page)
        results.append((path, html))
    # Validate both pages before changing either generated output.
    for path, html in results:
        path.write_text(html)
        print('Built ' + path.name)


if __name__ == '__main__':
    build()
