/* SPDX-License-Identifier: MPL-2.0
 * LOOM-8's screen mirror (the firmware's own device/mirror.c, MR_SEGW 80 as app/app.h sets it)
 * on the host: draw a glass, write the SysEx stream and the glass. No JieLi toolchain.
 *   cc -std=c99 -Wall -Wextra -Werror -Wno-unused-function -O2 -DPLAT_HOST -DMR_SEGW=80 \
 *      -Ibase/include -o display_mirror_host tests/host/display_mirror_host.c
 *   display_mirror_host OUTDIR
 * OUTDIR/stream.syx is what the host receives (F0..F7 frames). OUTDIR/screen.bin is the glass,
 * 240*240 RGB565, high byte first, the same layout tests/mirror_test.mjs reads. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#define PLAT_HOST 1
#include "plat.h"

static uint16_t dev[240 * 240];
static uint8_t mirror_on;
static uint32_t now_ms = 1000;
static void mirror_blit(uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint16_t *px);
static void mirror_fill(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint16_t c);
static int mr_test(int on) { (void)on; return 0; }

static void lcd_blit(uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint16_t *px)
{
    for (uint32_t j = 0; j < h; j++)
        for (uint32_t i = 0; i < w; i++)
            dev[(y + j) * 240u + x + i] = px[j * w + i];
    if (mirror_on)
        mirror_blit(x, y, w, h, px);
}
static void lcd_fill(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint16_t c)
{
    uint16_t sw = (uint16_t)((c >> 8) | (c << 8));
    for (uint32_t j = y; j < y + h; j++)
        for (uint32_t i = x; i < x + w; i++)
            dev[j * 240u + i] = sw;
    if (mirror_on)
        mirror_fill(x, y, w, h, c);
}

#define MRQ 2048u
#include "mirror.c"

static uint8_t stream[1 << 22];
static uint32_t stream_n;
static uint32_t mr_free(void) { return MRQ; }          /* room for every frame: the glass arrives whole */
static void mr_put(const uint8_t *p, uint32_t n)
{
    memcpy(stream + stream_n, p, n);
    stream_n += n;
}
static int mr_link(void) { return 1; }
static int mr_busy(void) { return 0; }
static int mr_ctl_send(const uint8_t *p, uint32_t n)
{
    memcpy(stream + stream_n, p, n);
    stream_n += n;
    return 0;
}
static void mr_redraw(void) {}
uint32_t plat_ms(void) { return now_ms; }
uint32_t plat_buttons(void) { return 0; }
uint32_t plat_keys(void) { return 0; }
uint32_t plat_master(void) { return 1800; }

#define RGB(r, g, b) ((uint16_t)((((r) >> 3) << 11) | (((g) >> 2) << 5) | ((b) >> 3)))

int main(int argc, char **argv)
{
    uint16_t row[240 * 8];
    char path[512];
    FILE *f;
    uint32_t i, x, y;
    if (argc != 2) {
        fprintf(stderr, "usage: display_mirror_host OUTDIR\n");
        return 2;
    }
    mirror_cmd(2);                                    /* the page's start: on, and draw it all */
    lcd_fill(0, 0, 240, 240, RGB(32, 28, 24));
    lcd_fill(8, 16, 60, 22, RGB(230, 90, 40));
    lcd_fill(0, 230, 240, 10, RGB(70, 170, 160));
    for (y = 0; y < 8; y++)
        for (x = 0; x < 240; x++) {
            uint16_t c = (x < 40) ? RGB(240, 220, 80) : (x < 90) ? RGB(40, 80, 200)
                         : RGB(20 + (x & 63), 30 + ((x * 3) & 63), 40 + ((x * 5) & 63));
            if (y == 3 && x >= 80 && x < 110)         /* a playhead: one band of a full-width row */
                c = RGB(255, 255, 255);
            row[y * 240 + x] = (uint16_t)((c >> 8) | (c << 8));
        }
    lcd_blit(0, 80, 240, 8, row);
    for (i = 0; i < 30 * 30; i++) {                   /* a small card: two colours, so the cache hits */
        uint16_t c = (i % 5) ? RGB(160, 110, 70) : RGB(20, 16, 12);
        row[i] = (uint16_t)((c >> 8) | (c << 8));
    }
    lcd_blit(100, 140, 30, 30, row);
    /* the same full-width band with one segment changed: only that span should need to move,
     * and the glass must still match afterwards */
    for (x = 0; x < 240; x++)
        if (x >= 160 && x < 200)
            row[x] = (uint16_t)((RGB(180, 40, 90) >> 8) | (RGB(180, 40, 90) << 8));
    lcd_blit(0, 80, 240, 8, row);
    now_ms += 30;
    mirror_step();                                    /* one panel report in the stream, between the pictures */
    snprintf(path, sizeof path, "%s/stream.syx", argv[1]);
    if (!(f = fopen(path, "wb")) || fwrite(stream, 1, stream_n, f) != stream_n) {
        perror(path);
        return 1;
    }
    fclose(f);
    snprintf(path, sizeof path, "%s/screen.bin", argv[1]);
    if (!(f = fopen(path, "wb"))) {
        perror(path);
        return 1;
    }
    for (i = 0; i < 240u * 240u; i++) {
        uint8_t px[2] = {(uint8_t)dev[i], (uint8_t)(dev[i] >> 8)};   /* panel order -> high byte first */
        if (fwrite(px, 1, 2, f) != 2) {
            perror(path);
            return 1;
        }
    }
    fclose(f);
    printf("session: %u bytes\n", stream_n);
    return 0;
}
