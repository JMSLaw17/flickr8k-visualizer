import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// JSDOM does not implement native dialog methods.
const dialogFocusOrigins = new WeakMap<HTMLDialogElement, HTMLElement | null>()
let lastFocusOutsideDialog: HTMLElement | null = null

document.addEventListener('focusin', (event) => {
  if (event.target instanceof HTMLElement && !event.target.closest('dialog')) {
    lastFocusOutsideDialog = event.target
  }
})

if (!HTMLDialogElement.prototype.showModal) {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement) {
      const activeElement = document.activeElement
      dialogFocusOrigins.set(
        this,
        activeElement instanceof HTMLElement && !this.contains(activeElement)
          ? activeElement
          : lastFocusOutsideDialog,
      )
      this.setAttribute('open', '')
    },
  })
}

if (!HTMLDialogElement.prototype.close) {
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement, returnValue = '') {
      this.returnValue = returnValue
      this.removeAttribute('open')

      const focusOrigin = dialogFocusOrigins.get(this)
      dialogFocusOrigins.delete(this)
      if (focusOrigin?.isConnected) focusOrigin.focus()
    },
  })
}

afterEach(cleanup)
