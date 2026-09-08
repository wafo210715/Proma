import { expect, test } from 'bun:test'
import { getBuiltinMcpDefinitions, RESERVED_BUILTIN_KEYS } from './baseline'

test('Given legacy search tools are removed When listing integrated MCP capabilities Then gpt-image stays exposed while runtime names stay reserved', () => {
  expect(getBuiltinMcpDefinitions().map((item) => item.id)).toEqual(['gpt-image'])
  expect(RESERVED_BUILTIN_KEYS).toEqual(new Set(['gpt-image', 'gpt_image', 'automation', 'collaboration']))
})
