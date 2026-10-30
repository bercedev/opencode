import path from "path"
import { mkdirSync } from "fs"
import { Flock } from "@opencode/util/flock"
import { onCleanup, onMount } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { readText, writeTextAtomic } from "../util/persistence"
import { safeWatch } from "../util/watch"
import { parsePromptInfo, type PromptInfo } from "./history"

export type StashEntry = {
  prompt: PromptInfo
  timestamp: number
}

export const MAX_STASH_ENTRIES = 50

export function parsePromptStash(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const value = JSON.parse(line) as unknown
        if (!value || typeof value !== "object") return
        const entry = value as Record<string, unknown>
        const prompt = parsePromptInfo(entry.prompt)
        if (!prompt || typeof entry.timestamp !== "number") return
        return { prompt, timestamp: entry.timestamp }
      } catch {
        return undefined
      }
    })
    .filter((line): line is StashEntry => line !== undefined)
    .slice(-MAX_STASH_ENTRIES)
}

function without(entries: StashEntry[], entry: StashEntry) {
  const index = entries.findLastIndex(
    (line) => line.timestamp === entry.timestamp && line.prompt.text === entry.prompt.text,
  )
  return index === -1 ? entries : entries.toSpliced(index, 1)
}

export const { use: usePromptStash, provider: PromptStashProvider } = createSimpleContext({
  name: "PromptStash",
  init: () => {
    const paths = useTuiPaths()
    const stashFile = "prompt-stash.jsonl"
    const stashPath = path.join(paths.state, stashFile)
    const locks = path.join(paths.state, "locks")
    const [store, setStore] = createStore({ entries: [] as StashEntry[] })

    const read = async () =>
      parsePromptStash(
        await readText(stashPath).catch((error) => {
          if (error.code === "ENOENT") return ""
          throw error
        }),
      )

    // Other TUIs write this file too, so a change is applied to what's on disk, never to this TUI's copy.
    let writes = Promise.resolve()
    const update = (change: (entries: StashEntry[]) => StashEntry[]) => {
      setStore("entries", change(unwrap(store.entries)).slice(-MAX_STASH_ENTRIES))
      writes = writes
        .then(() =>
          Flock.withLock(
            stashPath,
            async () => {
              const entries = change(await read()).slice(-MAX_STASH_ENTRIES)
              await writeTextAtomic(stashPath, entries.map((line) => JSON.stringify(line) + "\n").join(""))
              setStore("entries", entries)
            },
            { dir: locks },
          ),
        )
        .catch(() => {})
    }

    const reload = () =>
      read().then(
        (entries) => setStore("entries", entries),
        () => {},
      )
    onMount(reload)

    mkdirSync(paths.state, { recursive: true })
    let reloadTimer: ReturnType<typeof setTimeout> | undefined
    const watcher = safeWatch(paths.state, (_, file) => {
      if (file && !file.startsWith(stashFile)) return
      clearTimeout(reloadTimer)
      reloadTimer = setTimeout(reload, 50)
    })
    onCleanup(() => {
      clearTimeout(reloadTimer)
      watcher?.close()
    })

    const remove = (entry: StashEntry) => update((entries) => without(entries, entry))

    return {
      list() {
        return store.entries
      },
      push(entry: Omit<StashEntry, "timestamp">) {
        const stash = structuredClone(unwrap({ ...entry, timestamp: Date.now() }))
        update((entries) => [...entries, stash])
      },
      pop() {
        const entry = store.entries.at(-1)
        if (entry) remove(entry)
        return entry
      },
      remove,
    }
  },
})
