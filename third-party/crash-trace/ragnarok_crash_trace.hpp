// Copyright Ragnarok Offline contributors. GPL-3.0-or-later.
// RAGNAROKMAC: bounded local unwinding of the original Linux signal context.
#pragma once
#if defined(__linux__) && defined(RAGNAROK_CRASH_TRACE)
#define UNW_LOCAL_ONLY
#include <libunwind.h>
#include <signal.h>
#include <unistd.h>
#include <link.h>
#include <stdint.h>
#include <errno.h>

namespace ragnarok_crash_trace {
static void (*original_handler)(int) = nullptr;
static volatile sig_atomic_t handling = 0;
alignas(16) static unsigned char alternate_stack[128 * 1024];
static uintptr_t executable_base = 0, executable_begin = 0, executable_end = 0;

// Record executable ELF ranges at startup, outside signal handling. Reject
// guessed frames outside those mappings instead of printing stack data as PCs.
struct Range { uintptr_t begin, end; };
static Range executable_ranges[64];
static size_t range_count = 0;
static bool first_object = true;
static int find_executable(dl_phdr_info* info, size_t, void*) {
    if (first_object) { executable_base = info->dlpi_addr; executable_begin = UINTPTR_MAX; }
    for (unsigned n = 0; n < info->dlpi_phnum; ++n) {
        const auto& ph = info->dlpi_phdr[n];
        if (ph.p_type != PT_LOAD) continue;
        const uintptr_t begin = info->dlpi_addr + ph.p_vaddr;
        const uintptr_t end = begin + ph.p_memsz;
        if (first_object) {
            if (begin < executable_begin) executable_begin = begin;
            if (end > executable_end) executable_end = end;
        }
        if ((ph.p_flags & PF_X) && range_count < 64) executable_ranges[range_count++] = {begin, end};
    }
    first_object = false;
    return 0;
}
static bool mapped_instruction(uintptr_t ip) {
    for (size_t n = 0; n < range_count; ++n)
        if (ip >= executable_ranges[n].begin && ip < executable_ranges[n].end) return true;
    return false;
}
struct Line {
    char data[512]; size_t used = 0;
    void text(const char* value, size_t max = 256) {
        for (size_t i = 0; i < max && value[i] && used < sizeof(data) - 1; ++i)
            data[used++] = value[i];
    }
    void hex(uintptr_t value) {
        text("0x"); bool started = false;
        for (int shift = sizeof(value) * 8 - 4; shift >= 0; shift -= 4) {
            const unsigned digit = (value >> shift) & 15;
            if (digit || started || shift == 0) { started = true; if (used < sizeof(data) - 1) data[used++] = "0123456789abcdef"[digit]; }
        }
    }
    void emit() {
        data[used++] = '\n';
        size_t written = 0;
        for (unsigned tries = 0; written < used && tries < 4; ++tries) {
            const ssize_t n = write(STDERR_FILENO, data + written, used - written);
            if (n > 0) written += static_cast<size_t>(n);
            else if (n < 0 && errno == EINTR) continue;
            else break;
        }
    }
};
static void handler(int signal, siginfo_t* info, void* context) {
    if (handling) _exit(128 + signal);
    handling = 1;
    Line first;
    first.text("RAGNAROK_CRASH_TRACE v1 signal="); first.hex(signal);
    first.text(" fault_address="); first.hex(reinterpret_cast<uintptr_t>(info ? info->si_addr : nullptr));
    first.text(" executable_base="); first.hex(executable_base); first.emit();
    unw_cursor_t cursor;
    int step = -1;
    if (context && unw_init_local2(&cursor, static_cast<unw_context_t*>(context), UNW_INIT_SIGNAL_FRAME) >= 0) {
        for (unsigned frame = 0; frame < 32; ++frame) {
            unw_word_t ip = 0, offset = 0;
            if (unw_get_reg(&cursor, UNW_REG_IP, &ip) < 0) break;
            if (frame > 0 && !mapped_instruction(ip)) { step = -1; break; }
            Line line; line.text("RAGNAROK_CRASH_FRAME index="); line.hex(frame);
            line.text(" pc="); line.hex(ip);
            if (ip >= executable_begin && ip < executable_end) { line.text(" main_offset="); line.hex(ip - executable_base); }
            char name[256] = {};
            if (unw_get_proc_name(&cursor, name, sizeof(name), &offset) == 0) {
                line.text(" function="); line.text(name, sizeof(name)); line.text("+"); line.hex(offset);
            }
            line.emit();
            step = unw_step(&cursor);
            if (step <= 0) break;
        }
    }
    Line end; end.text(step == 0 ? "RAGNAROK_CRASH_TRACE_END complete" : "RAGNAROK_CRASH_TRACE_END partial"); end.emit();
    // Preserve upstream's save attempt and its default-signal re-raise. No
    // allocation, demangling, stdio or program recovery is attempted here.
    original_handler(signal);
}
static bool install(void (*previous)(int)) {
    original_handler = previous;
    dl_iterate_phdr(find_executable, nullptr);
    stack_t stack = {}; stack.ss_sp = alternate_stack; stack.ss_size = sizeof(alternate_stack);
    if (sigaltstack(&stack, nullptr) != 0) return false;
    struct sigaction action = {};
    action.sa_sigaction = handler;
    // A recursive fault goes directly to the default action, retaining whatever
    // original-context evidence was already emitted instead of looping forever.
    action.sa_flags = SA_SIGINFO | SA_ONSTACK | SA_RESETHAND;
    sigemptyset(&action.sa_mask);
    return sigaction(SIGSEGV, &action, nullptr) == 0 && sigaction(SIGFPE, &action, nullptr) == 0;
}
}
#endif
