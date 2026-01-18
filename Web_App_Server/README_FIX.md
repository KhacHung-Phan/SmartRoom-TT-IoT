# SmartRoom IoT – bản hoàn thiện (Web + ESP32)

## 1) Kiến trúc & luồng dữ liệu
- **Web (Dashboard / Sensors / Controls / Realtime)**
  - Nghe dữ liệu realtime từ Firebase RTDB để hiển thị (trạng thái, bảng realtime, biểu đồ).
  - Gửi lệnh điều khiển bằng cách ghi lên **`/device/state`**.
- **ESP32**
  - Đọc lệnh từ **`/device/state`** để biết user muốn bật/tắt gì & đang ở mode nào.
  - Chạy luật theo mode (AUTO_HOME / AWAY_ARMED / MANUAL).
  - Ghi heartbeat/report lên **`/device/report`**.
  - Ghi sensor/event lên **`/latest/*`** (`pir`, `sht`, `rfid`).

## 2) Các node Firebase quan trọng
- **`/device/state`** (Web -> ESP32)
  - Web ghi: `modeIdx`, `light`, `fan`, `siren`, `updatedAt`, `updatedBy`.
  - ESP32 đọc:
    - MANUAL: làm theo boolean.
    - AUTO_HOME / AWAY_ARMED: có thể tự chuyển MANUAL nếu user bấm relay.

- **`/device/report`** (ESP32 -> Web)
  - ESP32 ghi định kỳ: `ts`, `ip`, `rssi`, `modeIdx`, `secState`, `occupied`, `pirMotion`, ...

- **`/latest/pir`** (ESP32 -> Web)
  - `motion`, `occupied`, `ts`.

- **`/latest/sht`** (ESP32 -> Web)
  - `t`, `h`, `ts`.

- **`/latest/rfid`** (ESP32 -> Web)
  - `uid`, `uidKey`, `allowed`, `result`, `ts`.

- **`/device/acl/cards/<uidKey> = true`**
  - `uidKey` = UID in hoa, bỏ dấu `:`.

## 3) Mode mapping
- `modeIdx=0` -> **AUTO_HOME**
- `modeIdx=1` -> **AWAY_ARMED**
- `modeIdx=2` -> **MANUAL**

## 4) Web realtime 2s
Web dùng cơ chế:
- RTDB listener cập nhật khi dữ liệu thay đổi.
- **Tick nội bộ 2s** để cập nhật UI/biểu đồ/"Update" ngay cả khi dữ liệu ổn định.

## 4.1) Lệnh điều khiển "ngay lập tức"
ESP32 **không poll** `/device/state` nữa.

Thay vào đó, firmware dùng **Firebase RTDB REST streaming (SSE)** để nghe `/device/state`.
=> Web ghi xong là ESP32 nhận gần như tức thì (phụ thuộc WiFi/RSSI).

Để web và biểu đồ ổn định, ESP32 cũng gửi telemetry bằng **1 lần PATCH** mỗi 2s:
- `/device/report`
- `/latest/pir`
- `/latest/sht`

## 5) Lưu ý Firebase Auth (rất quan trọng)
RTDB rules của bạn đang là:
```json
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}
```
=> Web **phải đăng nhập Firebase Auth** thì mới đọc/ghi được RTDB.

File `firebase-init.js` đã hỗ trợ:
- Ưu tiên session cũ
- Thử Anonymous
- Nếu Anonymous bị tắt -> dùng Email/Password (mặc định giống ESP32)

Bạn có thể set nhanh credential bằng DevTools:
```js
setFirebaseCreds("email", "password")
```

**Không mở HTML bằng `file://`** (Firebase Auth dễ lỗi unauthorized-domain). Hãy chạy web bằng server:
- `python -m http.server 8080`
- hoặc VSCode Live Server
- hoặc Firebase Hosting.

## 6) ESP32
- `main.cpp` đã cấu hình relay **ACTIVE-LOW**.
- Pin I2C: SDA=21, SCL=22.

