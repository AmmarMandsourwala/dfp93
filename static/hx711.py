import time
import subprocess

CHIP = "gpiochip1"
DT = "47"
SCK = "45"

# 🔴 CALIBRATION (UPDATE THESE)
OFFSET = 83000   # measure this
SCALE = 20       # calculate this

def read_dt():
    return int(subprocess.getoutput(f"gpioget {CHIP} {DT}"))

def set_sck(val):
    subprocess.call(f"gpioset {CHIP} {SCK}={val}", shell=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL)

def read_raw():
    count = 0

    timeout = 0
    while read_dt() == 1:
        timeout += 1
        if timeout > 1000:
            return None

    for _ in range(24):
        set_sck(1)
        count <<= 1
        set_sck(0)

        if read_dt():
            count += 1

    set_sck(1)
    set_sck(0)

    if count & 0x800000:
        count -= 0x1000000

    return count

# 🔥 FAST + STABLE (averaging)
def get_weight():
    values = []
    for _ in range(5):   # small average for speed
        v = read_raw()
        if v is not None:
            values.append(v)

    if not values:
        return None

    avg = sum(values) / len(values)

    weight = (avg - OFFSET) / SCALE
    return weight


print("Reading RAW...")

try:
    while True:
        val = read_raw()
        if val is not None:
            print("Raw:", val)
        time.sleep(0.2)

except KeyboardInterrupt:
    print("\nStopped")