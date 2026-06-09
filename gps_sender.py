import argparse
import json
import math
import random
import time
from datetime import datetime, timezone

import serial


def nmea_checksum(sentence_body: str) -> str:
    """
    Calculate NMEA 0183 checksum.
    Input should not include '$' or '*'.
    """
    checksum = 0
    for char in sentence_body:
        checksum ^= ord(char)
    return f"{checksum:02X}"


def decimal_to_nmea_lat(lat: float):
    """
    Convert decimal latitude to NMEA format:
    DDMM.MMMM,N/S
    """
    direction = "N" if lat >= 0 else "S"
    lat = abs(lat)
    degrees = int(lat)
    minutes = (lat - degrees) * 60
    return f"{degrees:02d}{minutes:07.4f}", direction


def decimal_to_nmea_lon(lon: float):
    """
    Convert decimal longitude to NMEA format:
    DDDMM.MMMM,E/W
    """
    direction = "E" if lon >= 0 else "W"
    lon = abs(lon)
    degrees = int(lon)
    minutes = (lon - degrees) * 60
    return f"{degrees:03d}{minutes:07.4f}", direction


def make_gprmc(lat: float, lon: float, speed_knots: float = 0.0, course_deg: float = 0.0) -> str:
    """
    Create a basic GPRMC NMEA sentence.
    """
    now = datetime.now(timezone.utc)

    time_str = now.strftime("%H%M%S")
    date_str = now.strftime("%d%m%y")

    lat_nmea, lat_dir = decimal_to_nmea_lat(lat)
    lon_nmea, lon_dir = decimal_to_nmea_lon(lon)

    body = (
        f"GPRMC,{time_str},A,"
        f"{lat_nmea},{lat_dir},"
        f"{lon_nmea},{lon_dir},"
        f"{speed_knots:.1f},{course_deg:.1f},"
        f"{date_str},,,A"
    )

    checksum = nmea_checksum(body)
    return f"${body}*{checksum}"


def simulate_position(start_lat: float, start_lon: float, step: int):
    """
    Simulate slow movement around the starting coordinate.
    """
    radius = 0.0005
    angle = step * 0.1

    lat = start_lat + radius * math.sin(angle)
    lon = start_lon + radius * math.cos(angle)

    lat += random.uniform(-0.00002, 0.00002)
    lon += random.uniform(-0.00002, 0.00002)

    return lat, lon


def open_serial(port: str, baud: int, timeout: float):
    return serial.Serial(
        port=port,
        baudrate=baud,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
        timeout=timeout,
        write_timeout=timeout,
    )


def main():
    parser = argparse.ArgumentParser(
        description="Simulate GPS coordinates and send them over an RFD 900x-US serial telemetry radio."
    )

    parser.add_argument(
        "--port",
        default="/dev/ttyUSB0",
        help="Serial port for the RFD 900x-US, usually /dev/ttyUSB0 on Linux.",
    )

    parser.add_argument(
        "--baud",
        type=int,
        default=57600,
        help="Baud rate for RFD 900x-US. Default is usually 57600.",
    )

    parser.add_argument("--lat", type=float, default=32.7767, help="Starting latitude")
    parser.add_argument("--lon", type=float, default=-96.7970, help="Starting longitude")
    parser.add_argument("--interval", type=float, default=1.0, help="Seconds between messages")

    parser.add_argument(
        "--format",
        choices=["json", "nmea", "both"],
        default="both",
        help="Message format to send",
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print messages without opening the serial port",
    )

    args = parser.parse_args()

    ser = None

    if not args.dry_run:
        ser = open_serial(args.port, args.baud, timeout=1)
        print(f"Opened RFD 900x-US serial port {args.port} at {args.baud} baud.")
    else:
        print("Dry-run mode: not opening serial port.")

    print("Sending simulated GPS data. Press Ctrl+C to stop.")

    step = 0

    try:
        while True:
            lat, lon = simulate_position(args.lat, args.lon, step)

            payload = {
                "type": "gps",
                "timestamp_utc": datetime.now(timezone.utc).isoformat(),
                "lat": round(lat, 7),
                "lon": round(lon, 7),
                "source": "simulated",
                "radio": "RFD 900x-US",
            }

            messages = []

            if args.format in ["json", "both"]:
                messages.append(json.dumps(payload))

            if args.format in ["nmea", "both"]:
                messages.append(make_gprmc(lat, lon))

            for msg in messages:
                line = msg + "\r\n"
                print(line, end="")

                if ser is not None:
                    ser.write(line.encode("ascii"))
                    ser.flush()

            step += 1
            time.sleep(args.interval)

    except KeyboardInterrupt:
        print("\nStopped.")

    finally:
        if ser is not None and ser.is_open:
            ser.close()
            print("Serial port closed.")


if __name__ == "__main__":
    main()