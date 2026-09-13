// Deliberate faults using the diagnostic image's real sanitizer runtime.
// Never linked into rAthena or used with player data.
#include <climits>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <unistd.h>

extern "C" __attribute__((noinline)) void release_block(int* p) { free(p); }
extern "C" __attribute__((noinline)) int fault_uaf() {
    int* p = static_cast<int*>(malloc(sizeof(int)));
    *p = 17;
    release_block(p);
    return *static_cast<volatile int*>(p);
}
extern "C" __attribute__((noinline)) int fault_overflow() {
    volatile int value = INT_MAX;
    return value + 1;
}
extern "C" __attribute__((noinline, no_sanitize("undefined"))) int fault_segv() {
    volatile int* p = nullptr;
    return *p;
}
static void legacy_handler(int) {
    constexpr char text[] = "UNEXPECTED_LEGACY_HANDLER\n";
    write(2, text, sizeof(text) - 1);
    _exit(91);
}
int main(int argc, char** argv) {
    if (argc != 2) return 2;
    signal(SIGSEGV, legacy_handler);
    signal(SIGFPE, legacy_handler);
    if (strcmp(argv[1], "uaf") == 0) return fault_uaf();
    if (strcmp(argv[1], "overflow") == 0) return fault_overflow();
    if (strcmp(argv[1], "segv") == 0) return fault_segv();
    return 2;
}
