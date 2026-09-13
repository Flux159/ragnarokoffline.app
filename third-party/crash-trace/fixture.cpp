// Standalone validation of the exact handler embedded in the server.
#include "ragnarok_crash_trace.hpp"
#include <cstring>
static void original(int sig) { signal(sig, SIG_DFL); raise(sig); }
extern "C" __attribute__((noinline)) void original_fault(bool floating) {
    if (floating) {
#if defined(__x86_64__)
        // Real hardware divide fault, avoiding musl raise()'s assembly frames.
        unsigned divisor = 0;
        asm volatile("xorl %%edx, %%edx; movl $1, %%eax; divl %0" : : "r"(divisor) : "eax", "edx", "cc");
#else
        // AArch64 integer division by zero does not raise SIGFPE.
        raise(SIGFPE);
#endif
    }
    else { volatile int* pointer = nullptr; *pointer = 1; }
}
extern "C" __attribute__((noinline)) void fault_caller(bool floating) { original_fault(floating); asm volatile("" ::: "memory"); }
int main(int argc, char** argv) {
    if (!ragnarok_crash_trace::install(original)) return 2;
    fault_caller(argc > 1 && std::strcmp(argv[1], "fpe") == 0);
    return 3;
}
