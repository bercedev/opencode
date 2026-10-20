/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { DialogMessage } from "../../../src/routes/session/dialog-message"
import { ConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { RouteProvider } from "../../../src/context/route"
import { TuiAppProvider } from "../../../src/context/runtime"
import { SessionTabsProvider } from "../../../src/context/session-tabs"
import { StorageProvider, useStorage } from "../../../src/context/storage"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import type { PromptInfo } from "../../../src/prompt/history"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

// Revert from Message Actions while a turn is running has to stop the turn
// first, as /undo does; staging into a busy session fails and the prompt was
// already refilled (#57383).
test("Message Actions > Revert interrupts the turn before staging, then fills the prompt", async () => {
  const sessionID = "ses_revert"
  const order: string[] = []
  const events = createEventStream()
  const calls = createFetch((url, request) => {
    if (url.pathname === `/api/session/${sessionID}/message`)
      return json({
        data: [{ id: "msg_user", created: 0, type: "user", text: "Undo me", time: { created: 1 } }],
        cursor: {},
      })
    if (request.method !== "POST") return undefined
    if (url.pathname === `/api/session/${sessionID}/interrupt`) {
      order.push("interrupt")
      return json({ interrupted: true })
    }
    if (url.pathname === `/api/experimental/session/${sessionID}/wait`) {
      order.push("wait")
      return new Response(null, { status: 204 })
    }
    if (url.pathname === `/api/session/${sessionID}/revert/stage`) {
      order.push("stage")
      return json({ data: { messageID: "msg_user" } })
    }
    return undefined
  }, events)
  const temporary = await tmpdir()
  let storage!: ReturnType<typeof useStorage>

  function Probe() {
    const data = useData()
    const dialog = useDialog()
    storage = useStorage()
    onMount(async () => {
      await data.session.message.sync(sessionID)
      dialog.replace(() => (
        <DialogMessage
          sessionID={sessionID}
          messageID="msg_user"
          setPrompt={(prompt: PromptInfo) => order.push(`prompt:${prompt.text}`)}
        />
      ))
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ArgsProvider>
              <ConfigProvider config={createTuiResolvedConfig()}>
                <Keymap.Provider>
                  <ToastProvider>
                    <RouteProvider>
                      <ClientProvider api={createApi(calls.fetch)}>
                        <PermissionProvider>
                          <DataProvider directory={process.cwd()}>
                            <LocationProvider>
                              <SessionTabsProvider>
                                <ThemeProvider mode="dark" source={emptyThemeSource}>
                                  <LocalProvider>
                                    <DialogProvider>
                                      <Probe />
                                    </DialogProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </SessionTabsProvider>
                            </LocationProvider>
                          </DataProvider>
                        </PermissionProvider>
                      </ClientProvider>
                    </RouteProvider>
                  </ToastProvider>
                </Keymap.Provider>
              </ConfigProvider>
            </ArgsProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("Message Actions") && frame.includes("Revert"))
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await app.waitFor(() => order.some((step) => step.startsWith("prompt:")))
    expect(order).toEqual(["interrupt", "wait", "stage", "prompt:Undo me"])
  } finally {
    app.renderer.destroy()
    await storage.flush()
    await temporary[Symbol.asyncDispose]()
  }
})
