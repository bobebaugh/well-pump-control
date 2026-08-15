#pragma once

#include <stdint.h>

#include "esp_err.h"

enum class SdQualificationPhase : uint8_t {
    Starting,
    NotDetected,
    MountFailed,
    Mounted,
    AwaitingPhysicalConfirmation,
    Formatting,
    Qualified,
    Failed,
};

struct SdQualificationSnapshot {
    SdQualificationPhase phase;
    bool card_detected;
    bool mounted;
    bool fat32;
    uint64_t capacity_bytes;
    uint64_t free_bytes;
    uint64_t bytes_written;
    uint64_t bytes_read;
    uint32_t write_crc32;
    uint32_t read_crc32;
    esp_err_t esp_result;
    int fat_result;
    int system_result;
    char detail[96];
};

// Starts the only task permitted to touch SDMMC, FatFs, VFS, or test files.
void sd_qualification_begin();

// Returns a coherent snapshot; it never accesses the filesystem.
SdQualificationSnapshot sd_qualification_snapshot();

// The UI may request the post-hold physical-confirmation state. This does not
// format, mount, write, or otherwise access the filesystem.
bool sd_qualification_request_physical_confirmation();

// The UI may submit the distinct physical confirmation. The owner task still
// refuses to format unless the separate physical-approval build gate is open.
bool sd_qualification_confirm_physical_format();
