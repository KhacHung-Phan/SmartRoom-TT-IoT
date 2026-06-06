# SmartRoom-TT-IoT

## Overview

SmartRoom-TT-IoT is an IoT-based smart room monitoring and control system.  
The system is designed to monitor environmental conditions, detect security events, authenticate users with RFID/NFC, and control room devices in real time through Web/App interfaces.

The project uses ESP32 as the central controller, Firebase Realtime Database for data synchronization, and MQTT/WebSocket for real-time communication between devices and the dashboard.

## Main Features

- Real-time room monitoring and device control
- Temperature and humidity monitoring using SHT30 sensor
- Motion detection using PIR sensor
- RFID/NFC-based user authentication using PN532 module
- Device control with relay, fan, buzzer, and RGB LED
- Web/App dashboard for monitoring and control
- Firebase Realtime Database synchronization
- MQTT/WebSocket-based communication
- Three operating modes:
  - HOME: comfort mode
  - AWAY: security monitoring mode
  - NIGHT: quiet/night mode

## System Architecture

The system consists of the following main blocks:

1. Central Controller  
   ESP32 is used as the main processing unit to collect sensor data, process system logic, and communicate with cloud services.

2. Sensor Block  
   Includes SHT30 temperature/humidity sensor, PIR motion sensor, and PN532 RFID/NFC module.

3. Actuator Block  
   Includes relay, fan, buzzer, and RGB LED for device control and system status indication.

4. Communication and Monitoring Block  
   Uses Firebase Realtime Database, MQTT/WebSocket, and Web/App dashboard for real-time monitoring and control.

## Hardware Components

- ESP32 DevKit
- SHT30 temperature and humidity sensor
- PIR HC-SR501 motion sensor
- PN532 RFID/NFC module
- Relay module
- DC fan
- Buzzer
- RGB LED module
- Power supply module
- PCB / prototype board

## Technologies Used

- ESP32
- C/C++ / Arduino Framework
- HTML, CSS, JavaScript
- Node.js
- Firebase Realtime Database
- MQTT
- WebSocket
- JSON
- I2C, SPI, UART, GPIO

## Operating Modes

### HOME Mode

In HOME mode, the system focuses on comfort and automation.  
Environmental data such as temperature and humidity are monitored, and devices can be controlled automatically or manually.

### AWAY Mode

In AWAY mode, the system focuses on security monitoring.  
Motion detection and RFID/NFC authentication are used to detect abnormal events and trigger alerts.

### NIGHT Mode

In NIGHT mode, the system reduces unnecessary alerts and device activity to provide a quiet environment while still maintaining essential monitoring.

## Project Structure

```text
SmartRoom-TT-IoT/
│
├── FlatfomIO/                 # ESP32 firmware source code
├── Web_App_Server/            # Web/App dashboard and server files
├── PROTUES (...).pdsprj       # Proteus simulation project
├── final.code-workspace       # VS Code workspace
└── README.md
