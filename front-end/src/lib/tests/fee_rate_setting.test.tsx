import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { FeeRateSetting, formatFeeXch, parseFeePerCost } from '../../components/FeeRateSetting';

describe('fee rate setting', () => {
  it('accepts zero or a whole rate of at least the minimum', () => {
    expect(parseFeePerCost('0')).toBe(0n);
    expect(parseFeePerCost(' 5 ')).toBe(5n);
    expect(parseFeePerCost('25')).toBe(25n);
    for (const raw of ['', '4', '-1', '5.5', 'abc', '1234567890']) {
      expect(parseFeePerCost(raw)).toBeNull();
    }
  });

  it('formats estimates to six decimal places', () => {
    expect(formatFeeXch(300_000_000n)).toBe('0.0003 XCH');
    expect(formatFeeXch(275_000_000n)).toBe('0.000275 XCH');
    expect(formatFeeXch(1_250_000_000_000n)).toBe('1.25 XCH');
  });

  it('shows the chosen preset and estimates what it will cost', () => {
    const onChange = jest.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<FeeRateSetting feePerCost={10n} onChange={onChange} />);
    });
    const radio = (value: string) =>
      renderer.root.find((node) => node.type === 'input' && node.props.value === value);
    expect(radio('expedited').props.checked).toBe(true);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('0.0006 XCH');
    expect(text).toContain('0.00055 XCH');
    act(() => radio('minimum').props.onChange());
    expect(onChange).toHaveBeenCalledWith(5n);
    act(() => renderer.update(<FeeRateSetting feePerCost={0n} onChange={onChange} />));
    expect(JSON.stringify(renderer.toJSON())).toContain('Fees are off');
    act(() => renderer.unmount());
  });
});
