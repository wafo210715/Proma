import { expect, test } from 'bun:test'
import { getBuiltinMcpDefinitions, RESERVED_BUILTIN_KEYS } from './baseline'

test('Given Proma runtime tools When listing configurable integrated MCP capabilities Then media generation capabilities are exposed while runtime names stay reserved', () => {
  expect(getBuiltinMcpDefinitions().map((item) => item.id)).toEqual(['nano-banana', 'gpt-image'])
  expect(RESERVED_BUILTIN_KEYS).toEqual(new Set(['nano-banana', 'nano_banana', 'gpt-image', 'gpt_image', 'automation', 'collaboration']))
})
