#include "sd_qualification.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>

#include "diskio_impl.h"
#include "diskio_sdmmc.h"
#include "driver/sdmmc_host.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_rom_crc.h"
#include "esp_vfs_fat.h"
#include "ff.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sd_pwr_ctrl_by_on_chip_ldo.h"
#include "sdmmc_cmd.h"

namespace {
constexpr char kMountPoint[] = "/sdcard";
constexpr char kDrive[] = "0:";
constexpr uint8_t kDriveNumber = 0;
constexpr size_t kMaxOpenFiles = 4;
constexpr size_t kFormatWorkBufferSize = 32 * 1024;
constexpr size_t kTestChunkSize = 32 * 1024;
constexpr size_t kTestFileSize = 8 * 1024 * 1024;
constexpr char kTestFile[] = "/sdcard/.tab5_sd_qualification.bin";
constexpr int kSdLdoChannel = 4;
constexpr gpio_num_t kSdClk = GPIO_NUM_43;
constexpr gpio_num_t kSdCmd = GPIO_NUM_44;
constexpr gpio_num_t kSdD0 = GPIO_NUM_39;
constexpr gpio_num_t kSdD1 = GPIO_NUM_40;
constexpr gpio_num_t kSdD2 = GPIO_NUM_41;
constexpr gpio_num_t kSdD3 = GPIO_NUM_42;

// This branch is intentionally unable to format on its first flashed run.
// Change only after Bob gives separate, explicit approval with the erasable
// card physically inserted for that supervised qualification session.
constexpr bool kPhysicalFormatApprovalEnabled = false;

const char *TAG = "tab5-sd-qual";

enum class SdCommand : uint8_t { Probe, PreparePhysicalConfirmation, ConfirmFormat };

QueueHandle_t command_queue;
SemaphoreHandle_t snapshot_lock;
SdQualificationSnapshot state = {};

sd_pwr_ctrl_handle_t power_control;
sdmmc_card_t card = {};
FATFS *filesystem;
bool host_initialized;
bool filesystem_mounted;
bool format_prepared;

void publish(const SdQualificationSnapshot &next) {
    if (snapshot_lock) xSemaphoreTake(snapshot_lock, portMAX_DELAY);
    state = next;
    if (snapshot_lock) xSemaphoreGive(snapshot_lock);
}

SdQualificationSnapshot next_state(SdQualificationPhase phase, const char *detail,
                                   esp_err_t esp_result = ESP_OK, int fat_result = FR_OK,
                                   int system_result = 0) {
    SdQualificationSnapshot next = sd_qualification_snapshot();
    next.phase = phase;
    next.esp_result = esp_result;
    next.fat_result = fat_result;
    next.system_result = system_result;
    snprintf(next.detail, sizeof(next.detail), "%s", detail);
    return next;
}

uint64_t card_capacity_bytes() {
    return static_cast<uint64_t>(card.csd.capacity) * card.csd.sector_size;
}

void reset_card_state() {
    filesystem = nullptr;
    filesystem_mounted = false;
    memset(&card, 0, sizeof(card));
}

void deinitialize_host() {
    if (host_initialized) {
        const esp_err_t result = sdmmc_host_deinit();
        if (result != ESP_OK) ESP_LOGW(TAG, "SD host deinit failed: %s", esp_err_to_name(result));
    }
    host_initialized = false;
    reset_card_state();
}

esp_err_t initialize_card() {
    if (!power_control) {
        const sd_pwr_ctrl_ldo_config_t ldo = {.ldo_chan_id = kSdLdoChannel};
        const esp_err_t result = sd_pwr_ctrl_new_on_chip_ldo(&ldo, &power_control);
        if (result != ESP_OK) return result;
    }

    sdmmc_host_t host = SDMMC_HOST_DEFAULT();
    host.slot = SDMMC_HOST_SLOT_0;
    host.max_freq_khz = SDMMC_FREQ_HIGHSPEED;
    host.pwr_ctrl_handle = power_control;
    esp_err_t result = host.init();
    if (result != ESP_OK) return result;
    host_initialized = true;

    sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
    slot.width = 4;
    slot.clk = kSdClk;
    slot.cmd = kSdCmd;
    slot.d0 = kSdD0;
    slot.d1 = kSdD1;
    slot.d2 = kSdD2;
    slot.d3 = kSdD3;
    result = sdmmc_host_init_slot(host.slot, &slot);
    if (result != ESP_OK) {
        deinitialize_host();
        return result;
    }
    result = sdmmc_card_init(&host, &card);
    if (result != ESP_OK) {
        deinitialize_host();
        return result;
    }
    return ESP_OK;
}

void unmount_filesystem() {
    if (!filesystem_mounted) return;
    f_mount(nullptr, kDrive, 0);
    esp_vfs_fat_unregister_path(kMountPoint);
    ff_diskio_unregister(kDriveNumber);
    filesystem = nullptr;
    filesystem_mounted = false;
}

esp_err_t mount_filesystem(FRESULT *out_fat_result) {
    *out_fat_result = FR_OK;
    ff_diskio_register_sdmmc(kDriveNumber, &card);
    ff_sdmmc_set_disk_status_check(kDriveNumber, false);
    const esp_vfs_fat_conf_t config = {
        .base_path = kMountPoint,
        .fat_drive = kDrive,
        .max_files = kMaxOpenFiles,
    };
    const esp_err_t register_result = esp_vfs_fat_register_cfg(&config, &filesystem);
    if (register_result != ESP_OK) {
        ff_diskio_unregister(kDriveNumber);
        return register_result;
    }
    *out_fat_result = f_mount(filesystem, kDrive, 1);
    if (*out_fat_result != FR_OK) {
        f_mount(nullptr, kDrive, 0);
        esp_vfs_fat_unregister_path(kMountPoint);
        ff_diskio_unregister(kDriveNumber);
        filesystem = nullptr;
        return ESP_FAIL;
    }
    filesystem_mounted = true;
    return ESP_OK;
}

void update_space(SdQualificationSnapshot *next) {
    DWORD free_clusters = 0;
    FATFS *fs = nullptr;
    const FRESULT result = f_getfree(kDrive, &free_clusters, &fs);
    if (result == FR_OK && fs) {
        next->free_bytes = static_cast<uint64_t>(free_clusters) * fs->csize * card.csd.sector_size;
        next->fat32 = fs->fs_type == FS_FAT32;
    } else {
        next->fat32 = false;
        next->fat_result = result;
        snprintf(next->detail, sizeof(next->detail), "space query FatFs %d", result);
    }
}

void probe_card() {
    unmount_filesystem();
    deinitialize_host();
    format_prepared = false;
    SdQualificationSnapshot next = next_state(SdQualificationPhase::Starting, "probing card");
    next.card_detected = false;
    next.mounted = false;
    next.fat32 = false;
    next.capacity_bytes = 0;
    next.free_bytes = 0;
    next.bytes_written = 0;
    next.bytes_read = 0;
    next.write_crc32 = 0;
    next.read_crc32 = 0;
    publish(next);

    const esp_err_t result = initialize_card();
    if (result != ESP_OK) {
        next = next_state(SdQualificationPhase::NotDetected, "card initialization failed", result);
        publish(next);
        ESP_LOGW(TAG, "SD card not detected: %s (0x%lx)", esp_err_to_name(result), (unsigned long)result);
        return;
    }

    next.card_detected = true;
    next.capacity_bytes = card_capacity_bytes();
    FRESULT fat_result = FR_OK;
    const esp_err_t mount_result = mount_filesystem(&fat_result);
    if (mount_result != ESP_OK) {
        next = next_state(SdQualificationPhase::MountFailed, "mount failed", mount_result, fat_result);
        next.card_detected = true;
        next.capacity_bytes = card_capacity_bytes();
        publish(next);
        ESP_LOGW(TAG, "SD mount failed: esp=%s (0x%lx), FatFs=%d", esp_err_to_name(mount_result),
                 (unsigned long)mount_result, fat_result);
        return;
    }

    next = next_state(SdQualificationPhase::Mounted, "mounted", ESP_OK, fat_result);
    next.card_detected = true;
    next.mounted = true;
    next.capacity_bytes = card_capacity_bytes();
    update_space(&next);
    publish(next);
    ESP_LOGI(TAG, "SD card detected and mounted: %s, %llu bytes free",
             next.fat32 ? "FAT32" : "non-FAT32 FAT", (unsigned long long)next.free_bytes);
}

void prepare_physical_confirmation() {
    const SdQualificationSnapshot current = sd_qualification_snapshot();
    if (!host_initialized || !current.card_detected) {
        SdQualificationSnapshot next = next_state(SdQualificationPhase::Failed,
            "format hold rejected: no initialized card", ESP_ERR_INVALID_STATE);
        next.card_detected = current.card_detected;
        next.capacity_bytes = current.capacity_bytes;
        publish(next);
        return;
    }
    format_prepared = true;
    SdQualificationSnapshot next = next_state(SdQualificationPhase::AwaitingPhysicalConfirmation,
        "hold complete; physical confirmation required");
    next.card_detected = true;
    next.mounted = filesystem_mounted;
    next.capacity_bytes = card_capacity_bytes();
    update_space(&next);
    publish(next);
    ESP_LOGW(TAG, "SD format hold completed; awaiting distinct physical confirmation");
}

void fill_pattern(uint8_t *buffer, size_t offset, size_t length) {
    for (size_t i = 0; i < length; ++i) {
        const uint32_t index = static_cast<uint32_t>(offset + i);
        buffer[i] = static_cast<uint8_t>((index * 37u) ^ (index >> 7) ^ 0xa5u);
    }
}

bool write_and_verify(SdQualificationSnapshot *next) {
    uint8_t *buffer = static_cast<uint8_t *>(heap_caps_malloc(kTestChunkSize, MALLOC_CAP_8BIT));
    if (!buffer) {
        *next = next_state(SdQualificationPhase::Failed, "test buffer allocation failed", ESP_ERR_NO_MEM);
        return false;
    }

    FILE *file = fopen(kTestFile, "wb");
    if (!file) {
        *next = next_state(SdQualificationPhase::Failed, "test file create failed", ESP_FAIL, FR_OK, errno);
        free(buffer);
        return false;
    }

    uint32_t write_crc = 0;
    size_t written = 0;
    while (written < kTestFileSize) {
        const size_t chunk = (kTestFileSize - written) < kTestChunkSize ? (kTestFileSize - written) : kTestChunkSize;
        fill_pattern(buffer, written, chunk);
        if (fwrite(buffer, 1, chunk, file) != chunk) {
            *next = next_state(SdQualificationPhase::Failed, "test write failed", ESP_FAIL, FR_OK, errno);
            fclose(file);
            free(buffer);
            return false;
        }
        write_crc = esp_rom_crc32_le(write_crc, buffer, chunk);
        written += chunk;
    }

    const int flush_result = fflush(file);
    const int sync_result = flush_result == 0 ? fsync(fileno(file)) : -1;
    const int close_result = fclose(file);
    if (flush_result != 0 || sync_result != 0 || close_result != 0) {
        *next = next_state(SdQualificationPhase::Failed, "test flush/fsync/close failed", ESP_FAIL, FR_OK, errno);
        free(buffer);
        return false;
    }
    next->bytes_written = written;
    next->write_crc32 = write_crc;
    ESP_LOGI(TAG, "SD deterministic 8 MiB write and CRC completed");

    unmount_filesystem();
    FRESULT remount_fat = FR_OK;
    const esp_err_t remount_result = mount_filesystem(&remount_fat);
    if (remount_result != ESP_OK) {
        *next = next_state(SdQualificationPhase::Failed, "test remount failed", remount_result, remount_fat);
        next->card_detected = true;
        next->capacity_bytes = card_capacity_bytes();
        next->bytes_written = written;
        next->write_crc32 = write_crc;
        free(buffer);
        return false;
    }

    file = fopen(kTestFile, "rb");
    if (!file) {
        *next = next_state(SdQualificationPhase::Failed, "test file reopen failed", ESP_FAIL, FR_OK, errno);
        free(buffer);
        return false;
    }

    uint32_t read_crc = 0;
    size_t read = 0;
    while (read < kTestFileSize) {
        const size_t count = fread(buffer, 1, kTestChunkSize, file);
        if (count == 0 && ferror(file)) {
            *next = next_state(SdQualificationPhase::Failed, "test read failed", ESP_FAIL, FR_OK, errno);
            fclose(file);
            free(buffer);
            return false;
        }
        if (count == 0) break;
        read_crc = esp_rom_crc32_le(read_crc, buffer, count);
        read += count;
    }
    if (fclose(file) != 0) {
        *next = next_state(SdQualificationPhase::Failed, "test read close failed", ESP_FAIL, FR_OK, errno);
        free(buffer);
        return false;
    }

    next->bytes_read = read;
    next->read_crc32 = read_crc;
    if (read != written || read_crc != write_crc) {
        *next = next_state(SdQualificationPhase::Failed, "test length or CRC mismatch", ESP_FAIL);
        next->card_detected = true;
        next->mounted = true;
        next->capacity_bytes = card_capacity_bytes();
        next->bytes_written = written;
        next->bytes_read = read;
        next->write_crc32 = write_crc;
        next->read_crc32 = read_crc;
        free(buffer);
        return false;
    }

    if (remove(kTestFile) != 0) {
        *next = next_state(SdQualificationPhase::Failed, "qualified but test-file delete failed", ESP_FAIL, FR_OK, errno);
        next->card_detected = true;
        next->mounted = true;
        next->capacity_bytes = card_capacity_bytes();
        next->bytes_written = written;
        next->bytes_read = read;
        next->write_crc32 = write_crc;
        next->read_crc32 = read_crc;
        free(buffer);
        return false;
    }
    free(buffer);
    ESP_LOGI(TAG, "SD remount, 8 MiB readback, CRC, and test-file deletion completed");
    return true;
}

void format_and_qualify() {
    if (!format_prepared || !kPhysicalFormatApprovalEnabled) {
        SdQualificationSnapshot next = next_state(SdQualificationPhase::AwaitingPhysicalConfirmation,
            "format blocked: separate physical approval required", ESP_ERR_INVALID_STATE);
        const SdQualificationSnapshot current = sd_qualification_snapshot();
        next.card_detected = current.card_detected;
        next.mounted = current.mounted;
        next.fat32 = current.fat32;
        next.capacity_bytes = current.capacity_bytes;
        next.free_bytes = current.free_bytes;
        publish(next);
        ESP_LOGW(TAG, "SD format blocked by physical-approval gate");
        return;
    }

    SdQualificationSnapshot next = next_state(SdQualificationPhase::Formatting, "formatting; do not remove power");
    next.card_detected = true;
    next.mounted = false;
    next.capacity_bytes = card_capacity_bytes();
    publish(next);
    ESP_LOGW(TAG, "SD qualification formatting started");

    if (!host_initialized) {
        next = next_state(SdQualificationPhase::Failed, "format requested without initialized card", ESP_ERR_INVALID_STATE);
        publish(next);
        return;
    }

    unmount_filesystem();
    void *work = heap_caps_malloc(kFormatWorkBufferSize, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!work) {
        next = next_state(SdQualificationPhase::Failed, "32 KiB format buffer unavailable", ESP_ERR_NO_MEM);
        next.card_detected = true;
        next.capacity_bytes = card_capacity_bytes();
        publish(next);
        return;
    }

    ff_diskio_register_sdmmc(kDriveNumber, &card);
    const LBA_t partitions[] = {100, 0, 0, 0};
    FRESULT fat_result = f_fdisk(kDriveNumber, partitions, work);
    if (fat_result == FR_OK) {
        const MKFS_PARM params = {
            .fmt = FM_FAT32,
            .n_fat = 2,
            .align = 0,
            .n_root = 0,
            .au_size = 32 * 1024,
        };
        fat_result = f_mkfs(kDrive, &params, work, kFormatWorkBufferSize);
    }
    ff_diskio_unregister(kDriveNumber);
    free(work);

    if (fat_result != FR_OK) {
        next = next_state(SdQualificationPhase::Failed, "MBR/FAT32 format failed", ESP_FAIL, fat_result);
        next.card_detected = true;
        next.capacity_bytes = card_capacity_bytes();
        publish(next);
        return;
    }

    const esp_err_t mount_result = mount_filesystem(&fat_result);
    if (mount_result != ESP_OK) {
        next = next_state(SdQualificationPhase::Failed, "post-format mount failed", mount_result, fat_result);
        next.card_detected = true;
        next.capacity_bytes = card_capacity_bytes();
        publish(next);
        return;
    }

    next = next_state(SdQualificationPhase::Mounted, "FAT32 formatted and mounted", ESP_OK, fat_result);
    next.card_detected = true;
    next.mounted = true;
    next.capacity_bytes = card_capacity_bytes();
    update_space(&next);
    if (!next.fat32) {
        next.phase = SdQualificationPhase::Failed;
        snprintf(next.detail, sizeof(next.detail), "post-format filesystem is not FAT32");
        publish(next);
        return;
    }
    if (!write_and_verify(&next)) {
        publish(next);
        return;
    }

    next.phase = SdQualificationPhase::Qualified;
    next.card_detected = true;
    next.mounted = true;
    next.fat32 = true;
    next.capacity_bytes = card_capacity_bytes();
    update_space(&next);
    snprintf(next.detail, sizeof(next.detail), "SD qualified: FAT32, 8 MiB CRC verified");
    publish(next);
    ESP_LOGI(TAG, "SD qualification completed successfully");
}

void owner_task(void *) {
    SdCommand command;
    while (xQueueReceive(command_queue, &command, portMAX_DELAY) == pdTRUE) {
        if (command == SdCommand::Probe) probe_card();
        if (command == SdCommand::PreparePhysicalConfirmation) prepare_physical_confirmation();
        if (command == SdCommand::ConfirmFormat) format_and_qualify();
    }
}
}  // namespace

void sd_qualification_begin() {
    snapshot_lock = xSemaphoreCreateMutex();
    command_queue = xQueueCreate(3, sizeof(SdCommand));
    if (!snapshot_lock || !command_queue ||
        xTaskCreate(owner_task, "tab5-sd-owner", 10240, nullptr, 4, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "SD owner task startup failed");
        return;
    }
    SdQualificationSnapshot initial = {};
    initial.phase = SdQualificationPhase::Starting;
    snprintf(initial.detail, sizeof(initial.detail), "SD owner starting");
    publish(initial);
    const SdCommand probe = SdCommand::Probe;
    if (xQueueSend(command_queue, &probe, 0) != pdTRUE) {
        ESP_LOGE(TAG, "SD initial probe queueing failed");
    }
}

SdQualificationSnapshot sd_qualification_snapshot() {
    SdQualificationSnapshot copy = state;
    if (!snapshot_lock) return copy;
    xSemaphoreTake(snapshot_lock, portMAX_DELAY);
    copy = state;
    xSemaphoreGive(snapshot_lock);
    return copy;
}

bool sd_qualification_request_physical_confirmation() {
    if (!command_queue) return false;
    const SdCommand command = SdCommand::PreparePhysicalConfirmation;
    return xQueueSend(command_queue, &command, 0) == pdTRUE;
}

bool sd_qualification_confirm_physical_format() {
    if (!command_queue || !kPhysicalFormatApprovalEnabled) {
        ESP_LOGW(TAG, "SD format confirmation rejected: separate Bob approval is required");
        return false;
    }
    const SdCommand command = SdCommand::ConfirmFormat;
    return xQueueSend(command_queue, &command, 0) == pdTRUE;
}
