import { createElement as h } from 'react'

export function Button({ variant, size, children = null, ...props }) {
  return h('button', { type: 'button', ...props, className: 'cm-button' + (variant === 'primary' ? ' cm-primary' : '') }, children)
}

export function IconContextInjectionOutlineRegular({ size }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
    h('path', { d: 'M4 4h12v6M4 4v16h16v-6M11 12h11m-4-4 4 4-4 4' }))
}

export function DisclosureRow({ icon, title, open, onToggle, collapsedContent = null, keepContentWhenOpen = false, children = null }) {
  return h('div', null, h('button', { type: 'button', className: 'cm-disclosure', 'aria-expanded': open, onClick: onToggle },
    icon, title, (!open || keepContentWhenOpen) && collapsedContent, open ? ' ▴' : ' ▾'), open && children)
}

export function SegmentedTabs({ label, value, onChange, items }) {
  return h('div', { role: 'tablist', className: 'cm-tabs', 'aria-label': label }, items.map((item, index) =>
    h('button', { key: item.id, type: 'button', role: 'tab', id: item.id, 'aria-controls': item.panelId,
      'aria-selected': value === item.value, tabIndex: value === item.value ? 0 : -1,
      onClick: () => onChange(item.value), onKeyDown: event => {
        const next = { ArrowLeft: (index + items.length - 1) % items.length, ArrowRight: (index + 1) % items.length,
          Home: 0, End: items.length - 1 }[event.key]
        if (next === undefined) return
        event.preventDefault()
        event.currentTarget.parentElement.querySelectorAll('button')[next].focus()
        onChange(items[next].value)
      } }, item.label)))
}
