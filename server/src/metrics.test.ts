import { describe, it, expect } from 'vitest'
import { render } from './metrics'

describe('render (Prometheus text format)', () => {
  it('writes HELP/TYPE once per metric and one line per sample', () => {
    const txt = render([
      { name: 'x_eth', help: 'Some help.', type: 'gauge', values: [{ value: 1.5 }] },
      {
        name: 'y_eth',
        help: 'Per validator.',
        type: 'gauge',
        values: [
          { labels: { validator: 1 }, value: 32 },
          { labels: { validator: 2 }, value: 31.5 },
        ],
      },
    ])
    expect(txt).toBe(
      '# HELP x_eth Some help.\n# TYPE x_eth gauge\nx_eth 1.5\n' +
        '# HELP y_eth Per validator.\n# TYPE y_eth gauge\ny_eth{validator="1"} 32\ny_eth{validator="2"} 31.5\n',
    )
  })

  it('escapes label values and omits metrics without samples', () => {
    const txt = render([
      { name: 'empty', help: 'h', type: 'gauge', values: [] },
      { name: 'z', help: 'h', type: 'gauge', values: [{ labels: { note: 'a"b\\c' }, value: 0 }] },
    ])
    expect(txt).not.toContain('empty')
    expect(txt).toContain('z{note="a\\"b\\\\c"} 0')
  })

  it('writes NaN for non-finite values instead of breaking the scrape', () => {
    expect(render([{ name: 'n', help: 'h', type: 'gauge', values: [{ value: Infinity }] }])).toContain('n NaN')
  })
})
