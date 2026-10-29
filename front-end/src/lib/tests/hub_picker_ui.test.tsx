import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { HubPicker } from '../../components/HubPicker';

function renderPicker(defaultHubUrl?: string) {
  const onConnect = jest.fn();
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(React.createElement(HubPicker, { onConnect, defaultHubUrl }));
  });
  const root = renderer!.root;
  const input = () => root.find((n) => n.type === 'input' && n.props.role === 'combobox');
  return {
    onConnect,
    input,
    type: (value: string) => {
      act(() => {
        input().props.onChange({ target: { value }, currentTarget: { value }, nativeEvent: {} });
      });
    },
    connectButton: () =>
      root.find(
        (n) => n.type === 'button' && n.findAll((c) => c.children.includes('Connect')).length > 0,
      ),
    suggestions: () => root.find((n) => Array.isArray(n.props.items)).props.items,
    errorText: () =>
      root
        .findAll((n) => n.type === 'p' && n.props.className?.includes('text-alert-text'))
        .map((n) => n.children.join('')),
  };
}

describe('hub picker', () => {
  it('prefills hub.nokitlan.com and connects to it', () => {
    const picker = renderPicker();

    expect(picker.input().props.value).toBe('https://hub.nokitlan.com');

    act(() => {
      picker.connectButton().props.onClick();
    });

    expect(picker.onConnect).toHaveBeenCalledWith('https://hub.nokitlan.com');
  });

  it('requires a URL before connecting', () => {
    const picker = renderPicker();

    picker.type('');

    expect(picker.connectButton().props.disabled).toBe(true);
  });

  it('shows an error for an invalid URL and clears it on the next edit', () => {
    const picker = renderPicker();

    picker.type('ftp://hub.example.com');
    act(() => {
      picker.connectButton().props.onClick();
    });

    expect(picker.onConnect).not.toHaveBeenCalled();
    expect(picker.input().props['aria-invalid']).toBe(true);
    expect(picker.errorText()).toEqual(['Enter a valid URL (e.g. https://hub.example.com)']);

    picker.type('hub.example.com');

    expect(picker.errorText()).toEqual([]);
  });

  it('connects to the normalized origin of a typed URL', () => {
    const picker = renderPicker();

    picker.type(' hub.example.com/lobby ');
    act(() => {
      picker.connectButton().props.onClick();
    });

    expect(picker.onConnect).toHaveBeenCalledWith('https://hub.example.com');
  });

  it('prefills the last used hub and keeps the known hubs as suggestions', () => {
    const picker = renderPicker('https://my-hub.test');

    expect(picker.input().props.value).toBe('https://my-hub.test');
    expect(picker.suggestions()).toEqual(['https://my-hub.test', 'https://hub.nokitlan.com']);

    act(() => {
      picker.connectButton().props.onClick();
    });

    expect(picker.onConnect).toHaveBeenCalledWith('https://my-hub.test');
  });
});
