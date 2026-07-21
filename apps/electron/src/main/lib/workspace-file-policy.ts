import { relative, resolve, sep } from 'node:path'

/** 工作区递归遍历时跳过的目录名。 */
export const MIGRATION_BLOCKED_DIRS = new Set([
  '.claude', '.DS_Store', '.git', 'node_modules',
  '.venv', 'venv', 'dist', 'build', 'out',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo',
  '__pycache__', 'coverage', 'target',
])

/** `childPath` 是否位于 `parentPath` 内或与之相同。 */
export function isPathWithin(parentPath: string, childPath: string): boolean {
  const parent = resolve(parentPath)
  const child = resolve(childPath)
  const pathRelative = relative(parent, child)
  return pathRelative === '' || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== '..')
}
