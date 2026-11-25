import ctypes, sys
x11 = ctypes.cdll.LoadLibrary('libX11.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
d = x11.XOpenDisplay(None)
x11.XMoveWindow(ctypes.c_void_p(d), ctypes.c_ulong(int(sys.argv[1], 16)), int(sys.argv[2]), int(sys.argv[3]))
x11.XFlush(ctypes.c_void_p(d)); x11.XCloseDisplay(ctypes.c_void_p(d))
