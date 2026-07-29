/**
 * @jest-environment jsdom
 */

import { API_BASE, apiFetch } from '../JS/core/api.js';

describe('API_BASE', () => {
  test('apunta a localhost:3000 cuando el hostname es localhost', () => {
    // jsdom sirve las pruebas por defecto desde http://localhost/.
    expect(window.location.hostname).toBe('localhost');
    expect(API_BASE).toBe('http://localhost:3000');
  });
});

describe('apiFetch', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
  });

  test('llama a fetch con la URL completa (API_BASE + path)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await apiFetch('/ordenes');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe('http://localhost:3000/ordenes');
  });

  test('pasa method, headers y body a fetch tal cual, sin el timeout', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await apiFetch('/ordenes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"foo":"bar"}',
    });

    const [, options] = global.fetch.mock.calls[0];
    expect(options).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"foo":"bar"}',
    });
    // El timeout es un concepto propio de apiFetch: no debe filtrarse a fetch.
    expect(options.timeout).toBeUndefined();
  });

  test('sin timeout, no crea un AbortController ni agrega signal', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await apiFetch('/ordenes');

    const [, options] = global.fetch.mock.calls[0];
    expect(options.signal).toBeUndefined();
  });

  test('con timeout, agrega un signal de AbortController a la petición', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await apiFetch('/ordenes', { timeout: 5000 });

    const [, options] = global.fetch.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
  });

  test('con timeout, aborta la petición y expone AbortError si se agota el tiempo', async () => {
    jest.useFakeTimers();

    global.fetch = jest.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const promise = apiFetch('/ordenes', { timeout: 1000 });
    const expectacion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    jest.advanceTimersByTime(1000);
    await expectacion;

    jest.useRealTimers();
  });

  test('con timeout, limpia el temporizador si la petición resuelve antes de agotarse', async () => {
    jest.useFakeTimers();
    const clearSpy = jest.spyOn(global, 'clearTimeout');

    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await apiFetch('/ordenes', { timeout: 5000 });

    expect(clearSpy).toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('propaga el rechazo de fetch cuando falla por una razón distinta al timeout', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    await expect(apiFetch('/ordenes')).rejects.toThrow('Network error');
  });
});
