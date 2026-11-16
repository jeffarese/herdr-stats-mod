// A stand-in program for the demo's pictures. stage.sh compiles it under the names claude,
// cargo and node, so that's the name a process list shows. It draws a few plausible lines,
// then keeps the CPU busy so the stats have something to attribute: `share` cores on
// average, rising and falling by `swing` of that over `period` seconds, so charts have a shape.
//
//   claude 0.35 agent      about 35% of one core
//   cargo  5    build      about five cores, in waves
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static double share, swing, period_s, started;

static double now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

// Thread `i` covers the cores from i to i + 1 of the current target: busy for that share of
// every tenth of a second, asleep for the rest.
static void *burn(void *arg) {
  long i = (long)arg;
  const double tick = 0.1;
  for (;;) {
    double t = now();
    double target = share * (1 + swing * sin(2 * M_PI * (t - started) / period_s));
    double mine = target - i;
    if (mine > 1) mine = 1;
    if (mine < 0) mine = 0;
    while (now() - t < mine * tick) {
    }
    double rest = (1 - mine) * tick;
    if (rest > 0) usleep((useconds_t)(rest * 1e6));
  }
  return NULL;
}

int main(int argc, char **argv) {
  share = argc > 1 ? atof(argv[1]) : 0.3;
  const char *kind = argc > 2 ? argv[2] : "";
  swing = argc > 3 ? atof(argv[3]) : 0.5;
  period_s = argc > 4 ? atof(argv[4]) : 12;
  started = now();
  printf("\033[2J\033[H");
  if (!strcmp(kind, "agent")) {
    printf("\033]0;\xe2\x9c\xb3 Add tests for the checkout flow\007");
    printf("\n \033[38;5;173m\xe2\x9c\xbb\033[0m Writing tests for the checkout flow\xe2\x80\xa6\n\n");
    printf("   \033[2m\xe2\x8e\xbf  Read src/checkout/cart.ts (214 lines)\033[0m\n");
    printf("   \033[2m\xe2\x8e\xbf  Read src/checkout/payment.ts (138 lines)\033[0m\n");
    printf("   \033[2m\xe2\x8e\xbf  Edit tests/checkout.test.ts\033[0m\n");
  } else if (!strcmp(kind, "build")) {
    printf("\033]0;cargo build --release\007");
    const char *crates[] = {"serde", "tokio", "hyper", "tower", "axum", "sqlx", "shop-core", "shop-api"};
    for (size_t i = 0; i < sizeof crates / sizeof *crates; i++) printf("   \033[1;32mCompiling\033[0m %s\n", crates[i]);
    printf("    \033[1;36mBuilding\033[0m [=======================>   ] 412/468\n");
  } else if (!strcmp(kind, "dev")) {
    printf("\033]0;npm run dev\007");
    printf("\n  \033[1;32mVITE\033[0m v6.0.3  ready in 412 ms\n\n");
    printf("  \033[32m\xe2\x9e\x9c\033[0m  Local:   \033[36mhttp://localhost:5173/\033[0m\n");
  }
  printf("\033[?25l");
  fflush(stdout);

  long threads = (long)ceil(share * (1 + swing));
  if (threads < 1) threads = 1;
  for (long i = 1; i < threads; i++) {
    pthread_t t;
    pthread_create(&t, NULL, burn, (void *)i);
  }
  burn((void *)0);
  return 0;
}
