/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { TuiPathsProvider } from "../../src/context/runtime"
import { emptyPrompt } from "../../src/prompt/history"
import { parsePromptStash, PromptStashProvider, usePromptStash } from "../../src/prompt/stash"
import { tmpdir } from "../fixture/fixture"

const prompt = (text: string) => ({ prompt: { ...emptyPrompt(), text } })
const texts = (entries: ReadonlyArray<{ prompt: { text: string } }>) => entries.map((entry) => entry.prompt.text)

test("a stash shows up in a TUI that is already running", async () => {
  await using tmp = await tmpdir()
  await using a = await mount(tmp.path)
  await using b = await mount(tmp.path)

  a.stash.push(prompt("alpha"))

  await until(() => texts(b.stash.list()).includes("alpha"))
})

test("popping in one TUI keeps the stashes of another", async () => {
  await using tmp = await tmpdir()
  await using a = await mount(tmp.path)
  await using b = await mount(tmp.path)

  a.stash.push(prompt("alpha"))
  b.stash.push(prompt("beta"))
  expect(b.stash.pop()?.prompt.text).toBe("beta")

  await until(async () => (await disk(tmp.path)).join() === "alpha")
  await until(() => texts(b.stash.list()).join() === "alpha")
  expect(b.stash.pop()?.prompt.text).toBe("alpha")
  await until(async () => (await disk(tmp.path)).length === 0)
  await until(() => a.stash.list().length === 0)
})

test("concurrent stashes from two TUIs are all kept", async () => {
  await using tmp = await tmpdir()
  await using a = await mount(tmp.path)
  await using b = await mount(tmp.path)
  const expected = Array.from({ length: 10 }, (_, index) => [`a${index}`, `b${index}`]).flat()

  for (const text of expected) (text.startsWith("a") ? a : b).stash.push(prompt(text))

  await until(async () => (await disk(tmp.path)).length === expected.length)
  expect((await disk(tmp.path)).sort()).toEqual(expected.toSorted())
})

test("remove takes the entry it was given after the list moved", async () => {
  await using tmp = await tmpdir()
  await using a = await mount(tmp.path)
  await using b = await mount(tmp.path)
  a.stash.push(prompt("first"))
  a.stash.push(prompt("second"))
  a.stash.push(prompt("third"))
  await until(() => b.stash.list().length === 3)

  const second = b.stash.list()[1]
  a.stash.remove(a.stash.list()[0])
  await until(() => texts(b.stash.list()).join() === "second,third")
  b.stash.remove(second)

  await until(async () => (await disk(tmp.path)).join() === "third")
})

async function disk(state: string) {
  const content = await readFile(path.join(state, "prompt-stash.jsonl"), "utf8").catch(() => "")
  return texts(parsePromptStash(content))
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition was not met in time")
    await Bun.sleep(10)
  }
}

async function mount(state: string) {
  let stash!: ReturnType<typeof usePromptStash>
  function Consumer() {
    stash = usePromptStash()
    return <box />
  }
  const app = await testRender(() => (
    <TuiPathsProvider value={{ cwd: state, home: state, state, worktree: state }}>
      <PromptStashProvider>
        <Consumer />
      </PromptStashProvider>
    </TuiPathsProvider>
  ))
  await app.renderOnce()
  return {
    stash,
    async [Symbol.asyncDispose]() {
      // Let queued writes finish before the temp directory goes away.
      await Bun.sleep(100)
      app.renderer.destroy()
    },
  }
}
