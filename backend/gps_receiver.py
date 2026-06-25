import argparse
import json
from datetime import datetime, timezone
 
import serial
 
 
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
 
 
def parse_json_line(line: str):
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None
 
 
def main():
    parser = argparse.ArgumentParser(
        description="Receive GPS data from an RFD 900x-US serial telemetry radio."
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
 
    parser.add_argument(
        "--raw",
        action="store_true",
        help="Print raw received lines only.",
    )
 
    args = parser.parse_args()
 
    ser = open_serial(args.port, args.baud, timeout=1)
 
    print(f"Opened RFD 900x-US serial port {args.port} at {args.baud} baud.")
    print("Listening for GPS data. Press Ctrl+C to stop.")
 
    try:
        while True:
            raw = ser.readline()
 
            if not raw:
                continue
 
            line = raw.decode("ascii", errors="replace").strip()
 
            if not line:
                continue
 
            receive_time = datetime.now(timezone.utc).isoformat()
 
            if args.raw:
                print(line)
                continue
 
            data = parse_json_line(line)
 
            if data is not None:
                print("Received JSON GPS:")
                print(f"  receive_time_utc: {receive_time}")
                print(f"  timestamp_utc:    {data.get('timestamp_utc')}")
                print(f"  lat:              {data.get('lat')}")
                print(f"  lon:              {data.get('lon')}")
                print(f"  source:           {data.get('source')}")
                print(f"  radio:            {data.get('radio')}")
                print()
            elif line.startswith("$GPRMC") or line.startswith("$GNRMC"):
                print("Received NMEA GPS:")
                print(f"  receive_time_utc: {receive_time}")
                print(f"  sentence:         {line}")
                print()
            else:
                print("Received unknown data:")
                print(f"  {line}")
                print()
 
    except KeyboardInterrupt:
        print("\nStopped.")
 
    finally:
        if ser is not None and ser.is_open:
            ser.close()
            print("Serial port closed.")
 
 
if __name__ == "__main__":
    main()