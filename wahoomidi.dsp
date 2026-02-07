declare name "Wahoomidi";

import("stdfaust.lib");
freq = hslider("freq", 50, 30, 500, 1);
gain = hslider("gain", 0.1, 0, 1, 0.01);
gate = button("gate") : en.adsr(0.1, 0.2, 0.8, 2) ;
volume = hslider("volume",0.6,0,1,0.01);

lfreq = hslider("lfreq[midi:ctrl 48]",0.5,0.01,4,0.01);
lrange = hslider("lrange[midi:ctrl 49]",300,20,5000,0.01) * (1+2*gain);
lfo1 = os.lf_triangle(lfreq)*0.5+0.5;
lfo2 = os.lf_triangle(lfreq*1.01)*0.5+0.5;

process = os.sawtooth(freq)*gain*gate 
		<: 	fi.resonlp(lfo1*lrange+50,5,1)*volume, 
			fi.resonlp(lfo2*lrange+50,5,1)*volume; 

effect 	= par(i,2,ef.echo(1,0.25, 0.75)) 
		: co.limiter_1176_R4_stereo;