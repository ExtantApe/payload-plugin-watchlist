import type { Field } from 'payload'
import { describe, expect, it } from 'vitest'

import { BAD_SHAPE, checkShape } from '../src/shape.js'

// The field kinds a site's override can add, which the check walks too. Made-up data.
const inner: Field[] = [{ name: 'label', type: 'text' }, { name: 'state', type: 'json' }]
const fields: Field[] = [
  { name: 'box', type: 'group', fields: inner },
  { type: 'tabs', tabs: [{ name: 'named', fields: inner }, { label: 'Unnamed', fields: [{ type: 'collapsible', label: 'More', fields: [{ type: 'row', fields: [{ name: 'list', type: 'array', fields: inner }] }] }] }] },
  { name: 'parts', type: 'blocks', blocks: [{ slug: 'inline', fields: inner }] },
  { name: 'shared', type: 'blocks', blocks: [], blockReferences: ['named-block'] } as unknown as Field,
  { name: 'spoken', type: 'group', localized: true, fields: inner },
  { name: 'spokenList', type: 'array', localized: true, fields: inner },
  { name: 'text', type: 'richText' },
  { name: 'raw', type: 'json' },
  { name: 'spot', type: 'point' },
]
const blocks = { 'named-block': { slug: 'named-block', fields: inner } }
const bad = { $made: 'up' }

describe('the walk along the fields', () => {
  const inside: [string, (row: object) => object][] = [
    ['a group', (row) => ({ box: row })],
    ['a named tab', (row) => ({ named: row })],
    ['a list in an unnamed tab', (row) => ({ list: [row] })],
    ['a block', (row) => ({ parts: [{ blockType: 'inline', ...row }] })],
    ['a block named by slug', (row) => ({ shared: [{ blockType: 'named-block', ...row }] })],
    ['a group in every locale', (row) => ({ spoken: { en: { label: 'x' }, fr: row } })],
    ['a group in one locale', (row) => ({ spoken: row })],
    ['a list in every locale', (row) => ({ spokenList: { en: [], fr: [row] } })],
  ]
  for (const [where, wrap] of inside)
    it(`checks ${where}`, () => {
      expect(() => checkShape(wrap({ label: 'x', state: { $kept: 1, 'a.b': 2 } }), fields, blocks)).not.toThrow()
      for (const extra of [bad, { 'made.up': 'x' }]) expect(() => checkShape(wrap({ label: 'x', ...extra }), fields, blocks)).toThrow(BAD_SHAPE)
    })

  it('leaves rich text, json and point values alone', () => {
    expect(() => checkShape({ text: { root: bad }, raw: [{ id: '1', ...bad }, { id: '1' }], spot: [1, 2] }, fields, blocks)).not.toThrow()
  })

  it('takes the same id in two lists, and rows with no id', () => {
    expect(() => checkShape({ list: [{ id: '1' }, { id: '' }, {}, { id: '' }], parts: [{ id: '1', blockType: 'inline' }] }, fields, blocks)).not.toThrow()
    expect(() => checkShape({ parts: [{ id: 1, blockType: 'inline' }, { id: '1', blockType: 'inline' }] }, fields, blocks)).toThrow(BAD_SHAPE)
  })

  it('leaves data that isn’t an object to Payload', () => {
    for (const data of [undefined, null, 'x', 3, []]) expect(() => checkShape(data, fields, blocks)).not.toThrow()
  })
})
