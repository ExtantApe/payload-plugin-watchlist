import { beforeEach } from 'vitest'

/** Nothing in the tests may reach the network: a call to the global fetch fails the test that made it. */
export const networkCalls: string[] = []
beforeEach(() => {
  globalThis.fetch = (async (input: unknown) => {
    networkCalls.push(String(input))
    throw new Error('The tests never use the network.')
  }) as typeof fetch
})
