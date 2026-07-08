#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  // Give the XS VM explicit heap sizes. The firmware default is a single
  // 32 KB arena shared by stack + slots + chunks, and the compiled mod
  // archive (mc.xsa bytecode, ~13 KB for this app) is loaded into that same
  // arena — measured 2026-07-07: the app booted with ~3 KB of free heap and
  // died "Alloy: Fatal Error / memory full" on the first allocation burst
  // (docs/WATCH-DEBUGGING-PLAYBOOK.md §B).
  //
  // Semantics (firmware src/fw/applib/moddable/moddable.c): if any of
  // stack/slot/chunk is nonzero, ALL THREE must be nonzero — otherwise the
  // machine is silently never created and the app exits at launch. stack and
  // slot are bytes (converted to xsSlot counts); chunk is bytes. When the sum
  // exceeds the 32 KB arena, the heaps are allocated separately from the app
  // heap (~122 KB total on emery) with growth disabled — so size generously.
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 8 * 1024,   // XS stack (512 slots)
    .slot = 32 * 1024,   // JS objects (2048 slots)
    .chunk = 32 * 1024,  // strings/buffers/bytecode (~13 KB is the code itself)
    // Memory instrumentation streams via `pebble logs --phone <IP>`; the
    // firmware disables it automatically when no log listener is attached.
    .flags = kModdableCreationFlagLogInstrumentation
#ifdef PBL_DEBUG
             // Built with `pebble build --debug`: enable the xsbug debugger.
             | kModdableCreationFlagDebug
#endif
  };
  moddable_createMachine(&cr);

  window_destroy(w);
}
