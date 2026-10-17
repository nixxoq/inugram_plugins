/**
 * Android JVM listener registration, reflection classes, and memory lifecycle manager.
 */

let nextListenerId = 1
const clickCallbacks = new Map<number, () => void>()
const dismissCallbacks = new Map<number, () => void>()
const keyCallbacks = new Map<number, (code: number, event: JavaObject) => boolean>()
const touchCallbacks = new Map<number, (v: JavaObject, event: JavaObject) => boolean>()
const viewsWithListeners = new Set<JavaObject>()
const dialogsWithListeners = new Set<JavaObject>()

let clickListenerClass: DefinedClass | null = null
let dismissListenerClass: DefinedClass | null = null
let keyListenerClass: DefinedClass | null = null
let touchListenerClass: DefinedClass | null = null

function getClickListenerClass(): DefinedClass {
  if (!clickListenerClass) {
    clickListenerClass = inu.jvm.defineClass({
      interfaces: [inu.jvm.cls('android.view.View$OnClickListener')],
      fields: { id: 'int' },
      methods: {
        onClick: (self, v) => {
          try {
            const id = Number(self.getField('id'))
            clickCallbacks.get(id)?.()
          } catch (err) {
            console.error('[DocViewer] Click callback error:', err)
          }
        },
      },
    })
  }
  return clickListenerClass
}

function getDismissListenerClass(): DefinedClass {
  if (!dismissListenerClass) {
    dismissListenerClass = inu.jvm.defineClass({
      interfaces: [inu.jvm.cls('android.content.DialogInterface$OnDismissListener')],
      fields: { id: 'int' },
      methods: {
        onDismiss: (self) => {
          try {
            const id = Number(self.getField('id'))
            const cb = dismissCallbacks.get(id)
            dismissCallbacks.delete(id)
            cb?.()
          } catch (err) {
            console.error('[DocViewer] Dismiss callback error:', err)
          }
        },
      },
    })
  }
  return dismissListenerClass
}

function getKeyListenerClass(): DefinedClass {
  if (!keyListenerClass) {
    keyListenerClass = inu.jvm.defineClass({
      interfaces: [inu.jvm.cls('android.content.DialogInterface$OnKeyListener')],
      fields: { id: 'int' },
      methods: {
        onKey: (self, _d, keyCode, event) => {
          try {
            const id = Number(self.getField('id'))
            const cb = keyCallbacks.get(id)
            if (cb) {
              return Boolean(cb(Number(keyCode), event as JavaObject))
            }
          } catch (err) {
            console.error('[DocViewer] Key callback error:', err)
          }
          return false
        },
      },
    })
  }
  return keyListenerClass
}

function getTouchListenerClass(): DefinedClass {
  if (!touchListenerClass) {
    touchListenerClass = inu.jvm.defineClass({
      interfaces: [inu.jvm.cls('android.view.View$OnTouchListener')],
      fields: { id: 'int' },
      methods: {
        onTouch: (self, v, event) => {
          try {
            const id = Number(self.getField('id'))
            const cb = touchCallbacks.get(id)
            if (cb) {
              return Boolean(cb(v as JavaObject, event as JavaObject))
            }
          } catch (err) {
            console.error('[DocViewer] Touch callback error:', err)
          }
          return false
        },
      },
    })
  }
  return touchListenerClass
}

export function registerClick(view: JavaObject, onClick: () => void): number {
  const id = nextListenerId++
  clickCallbacks.set(id, onClick)
  viewsWithListeners.add(view)
  const Cls = getClickListenerClass()
  const listener = new Cls()
  listener.setField('id', id)
  view.call('setOnClickListener', listener)
  return id
}

export function registerDismiss(dialog: JavaObject, onDismiss: () => void): number {
  const id = nextListenerId++
  dismissCallbacks.set(id, onDismiss)
  dialogsWithListeners.add(dialog)
  const Cls = getDismissListenerClass()
  const listener = new Cls()
  listener.setField('id', id)
  dialog.call('setOnDismissListener', listener)
  return id
}

export function registerKey(
  dialog: JavaObject,
  onKey: (code: number, event: JavaObject) => boolean
): number {
  const id = nextListenerId++
  keyCallbacks.set(id, onKey)
  dialogsWithListeners.add(dialog)
  const Cls = getKeyListenerClass()
  const listener = new Cls()
  listener.setField('id', id)
  dialog.call('setOnKeyListener', listener)
  return id
}

export function registerTouch(
  view: JavaObject,
  onTouch: (v: JavaObject, event: JavaObject) => boolean
): number {
  const id = nextListenerId++
  touchCallbacks.set(id, onTouch)
  viewsWithListeners.add(view)
  const Cls = getTouchListenerClass()
  const listener = new Cls()
  listener.setField('id', id)
  view.call('setOnTouchListener', listener)
  return id
}

export function cleanupListener(id: number): void {
  clickCallbacks.delete(id)
  dismissCallbacks.delete(id)
  keyCallbacks.delete(id)
  touchCallbacks.delete(id)
}

export function cleanupAllListeners(ids: number[]): void {
  for (const id of ids) {
    cleanupListener(id)
  }
}

export function detachAllViewListeners(): void {
  for (const view of viewsWithListeners) {
    try {
      view.call('setOnClickListener', null)
      view.call('setOnTouchListener', null)
    } catch {}
  }
  viewsWithListeners.clear()

  for (const dialog of dialogsWithListeners) {
    try {
      dialog.call('setOnDismissListener', null)
      dialog.call('setOnKeyListener', null)
    } catch {}
  }
  dialogsWithListeners.clear()

  clickCallbacks.clear()
  dismissCallbacks.clear()
  keyCallbacks.clear()
  touchCallbacks.clear()
}

