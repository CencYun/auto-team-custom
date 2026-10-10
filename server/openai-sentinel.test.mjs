import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveSentinelExecutablePath } from './openai-sentinel.mjs';

test('finds the installed macOS Chrome without environment configuration', async () => {
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(await resolveSentinelExecutablePath({
    env: {},
    platform: 'darwin',
    homeDirectory: '/Users/example',
    canExecute: async (candidate) => candidate === chromePath,
  }), chromePath);
});

test('falls back to a browser installed in the macOS user Applications directory', async () => {
  const chromePath = '/Users/example/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(await resolveSentinelExecutablePath({
    env: { SENTINEL_BROWSER_PATH: '/missing-browser' },
    platform: 'darwin',
    homeDirectory: '/Users/example',
    canExecute: async (candidate) => {
      if (candidate === '/missing-browser') throw new Error('ENOENT');
      return candidate === chromePath;
    },
  }), chromePath);
});

test('configured Sentinel browser takes priority over Chrome and installed browsers', async () => {
  const candidates = [];
  assert.equal(await resolveSentinelExecutablePath({
    env: { SENTINEL_BROWSER_PATH: '/configured-browser', CHROME_PATH: '/configured-chrome' },
    platform: 'darwin',
    canExecute: async (candidate) => {
      candidates.push(candidate);
      return true;
    },
  }), '/configured-browser');
  assert.deepEqual(candidates, ['/configured-browser']);
});

test('falls back from a missing Sentinel override to CHROME_PATH', async () => {
  assert.equal(await resolveSentinelExecutablePath({
    env: { SENTINEL_BROWSER_PATH: '/missing-browser', CHROME_PATH: '/configured-chrome' },
    platform: 'linux',
    canExecute: async (candidate) => candidate === '/configured-chrome',
  }), '/configured-chrome');
});

test('finds Linux Chromium and Windows per-user Chrome', async () => {
  for (const options of [
    { env: {}, platform: 'linux', expected: '/usr/bin/chromium' },
    { env: { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' }, platform: 'win32', expected: 'C:\\Users\\example\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe' },
  ]) {
    assert.equal(await resolveSentinelExecutablePath({
      ...options,
      canExecute: async (candidate) => candidate === options.expected,
    }), options.expected);
  }
});

test('reports unavailable when no executable candidate is present', async () => {
  await assert.rejects(resolveSentinelExecutablePath({
    env: {},
    platform: 'darwin',
    canExecute: async () => false,
  }), /sentinel_browser_unavailable/);
});

test('checks the configured browser is an executable file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-team-browser-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'chrome');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(await resolveSentinelExecutablePath({
    env: { SENTINEL_BROWSER_PATH: executable },
    platform: 'test',
  }), executable);
  await assert.rejects(resolveSentinelExecutablePath({
    env: { SENTINEL_BROWSER_PATH: directory },
    platform: 'test',
  }), /sentinel_browser_unavailable/);
  if (process.platform !== 'win32') {
    await chmod(executable, 0o644);
    await assert.rejects(resolveSentinelExecutablePath({
      env: { SENTINEL_BROWSER_PATH: executable },
      platform: 'test',
    }), /sentinel_browser_unavailable/);
  }
});
