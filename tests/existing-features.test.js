import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const settingsScript = await read('assets/js/settings.js');
const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
async function settle() { await new Promise(setImmediate); await new Promise(setImmediate); }

test('manual Telegram still uses unsaved values, guards duplicate clicks, and never writes logs/settings', async () => {
  const dom = new JSDOM(await read('settings.html'), { url: 'https://example.test/settings.html', runScripts: 'outside-only' });
  const { window } = dom;
  const calls = [];
  let finish;
  window.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/settings') return Response.json({}, { status: 404 });
    return new Promise(resolve => { finish = resolve; });
  };
  try {
    window.eval(settingsScript); await settle();
    const form = window.document.getElementById('settingsForm');
    form.elements.telegramToken.value = token; form.elements.telegramChatId.value = '-1001234567890';
    form.elements.brokerPort.value = '';
    const button = window.document.getElementById('testTelegram');
    button.click(); button.dispatchEvent(new window.Event('click')); await settle();
    assert.equal(button.disabled, true); assert.equal(calls.length, 2);
    assert.match(calls[1].url, new RegExp(`bot${token}/sendMessage$`));
    assert.match(calls[1].options.body.get('text'), /\[UJI\] ThermoGuard-CPS/);
    assert.equal(window.localStorage.length, 0); assert.equal(form.elements.telegramEnabled.checked, false);
    finish(Response.json({ ok: true, result: { message_id: 15 } })); await settle();
    assert.equal(button.disabled, false); assert.match(window.document.getElementById('telegramTestStatus').textContent, /Berhasil/);
    assert.equal(calls.filter(call => call.url.includes('/api/ingest')).length, 0);
    form.elements.brokerPort.value = '8084';
    form.dispatchEvent(new window.Event('submit', { cancelable: true })); await settle();
    assert.equal(JSON.parse(window.localStorage.getItem('thermoguard.settings.v1')).telegramToken, token);
    window.document.getElementById('resetSettings').click(); await settle();
    assert.equal(form.elements.telegramToken.value, '');
  } finally { dom.window.close(); }
});

test('Normal/Warning/Critical remain local even with automatic Telegram enabled and MQTT online', async () => {
  const dom = new JSDOM(await read('index.html'), { url: 'https://example.test/index.html', runScripts: 'outside-only' });
  const { window } = dom;
  const calls = [], ticks = [];
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.setInterval = fn => { ticks.push(fn); return ticks.length; };
  window.clearInterval = () => {};
  const saved = { telegramEnabled: true, telegramToken: token, telegramChatId: '1234', updatedAt: 0 };
  window.localStorage.setItem('thermoguard.settings.v1', JSON.stringify(saved));
  window.fetch = async (url, options) => { calls.push({ url, options }); return Response.json(saved); };
  let mqtt;
  try {
    window.eval(settingsScript);
    window.eval(await read('assets/js/mock-data.js'));
    window.ThermoGuard.MQTTClient = class extends window.EventTarget {
      constructor(settings) { super(); this.settings = settings; this.online = false; mqtt = this; }
      connect() {} stop() {}
    };
    window.eval(await read('assets/js/app.js')); await settle();
    for (const online of [false, true]) {
      mqtt.online = online; mqtt.dispatchEvent(new window.CustomEvent('state', { detail: { online, detail: 'test' } }));
      for (const mode of ['NORMAL', 'WARNING', 'CRITICAL']) {
        window.document.querySelector(`[data-scenario=${mode}]`).click(); ticks.forEach(tick => tick());
        assert.equal(window.document.getElementById('modeName').textContent, mode);
        assert.equal(calls.filter(call => call.url.includes('/api/ingest') || call.url.includes('api.telegram.org')).length, 0);
      }
    }
  } finally { dom.window.close(); }
});
