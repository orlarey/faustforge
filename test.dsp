import("stdfaust.lib");

process = os.osc(freq)*gain;

freq = hslider("midi key", 60, 0, 127, 1) : ba.midikey2hz;
gain = hslider("gain", 0.5, 0, 1, 0.01);