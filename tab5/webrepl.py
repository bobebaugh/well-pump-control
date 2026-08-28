# Release: 2026-08-22 — vendor the official MicroPython-lib WebREPL server wrapper.
# Source: micropython-lib/micropython/net/webrepl/webrepl.py (MIT license).

import binascii
import hashlib
from micropython import const
import network
import os
import socket
import sys
import websocket
import _webrepl

listen_s = None
client_s = None

DEBUG = 0

_DEFAULT_STATIC_HOST = const("https://micropython.org/webrepl/")
static_host = _DEFAULT_STATIC_HOST


def server_handshake(cl):
    req = cl.makefile("rwb", 0)
    # Skip HTTP GET line.
    line = req.readline()
    if DEBUG:
        sys.stdout.write(repr(line))

    webkey = None
    upgrade = False
    websocket_upgrade = False

    while True:
        line = req.readline()
        if not line:
            return False
        if line == b"\r\n":
            break
        if DEBUG:
            sys.stdout.write(line)
        header, value = [x.strip() for x in line.split(b":", 1)]
        if header == b"Sec-WebSocket-Key":
            webkey = value
        elif header == b"Connection" and b"Upgrade" in value:
            upgrade = True
        elif header == b"Upgrade" and value == b"websocket":
            websocket_upgrade = True

    if not (upgrade and websocket_upgrade and webkey):
        return False

    digest = hashlib.sha1(webkey)
    digest.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    response_key = binascii.b2a_base64(digest.digest())[:-1]

    cl.send(
        b"""\
HTTP/1.1 101 Switching Protocols\r
Upgrade: websocket\r
Connection: Upgrade\r
Sec-WebSocket-Accept: """
    )
    cl.send(response_key)
    cl.send("\r\n\r\n")
    return True


def send_html(cl):
    cl.send(
        b"""\
HTTP/1.0 200 OK\r
\r
<base href=\""""
    )
    cl.send(static_host)
    cl.send(
        b"""\"></base>\r
<script src="webrepl_content.js"></script>\r
"""
    )
    cl.close()


def _network_interface_ids():
    """Support both current and legacy MicroPython WLAN constant locations."""
    if hasattr(network.WLAN, "IF_AP") and hasattr(network.WLAN, "IF_STA"):
        return (network.WLAN.IF_AP, network.WLAN.IF_STA)
    return (network.AP_IF, network.STA_IF)


def setup_conn(port, accept_handler):
    global listen_s
    listen_s = socket.socket()
    listen_s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

    address = socket.getaddrinfo("0.0.0.0", port)[0][4]
    listen_s.bind(address)
    listen_s.listen(1)
    if accept_handler:
        listen_s.setsockopt(socket.SOL_SOCKET, 20, accept_handler)
    for interface_id in _network_interface_ids():
        interface = network.WLAN(interface_id)
        if interface.active():
            print("WebREPL server started on http://%s:%d/" %
                  (interface.ifconfig()[0], port))
    return listen_s


def accept_conn(listen_sock):
    global client_s
    client, remote_address = listen_sock.accept()

    if not server_handshake(client):
        send_html(client)
        return False

    previous = os.dupterm(None)
    os.dupterm(previous)
    if previous:
        print("\nConcurrent WebREPL connection from", remote_address, "rejected")
        client.close()
        return False
    print("\nWebREPL connection from:", remote_address)
    client_s = client

    web_socket = websocket.websocket(client, True)
    web_socket = _webrepl._webrepl(web_socket)
    client.setblocking(False)
    if hasattr(os, "dupterm_notify"):
        client.setsockopt(socket.SOL_SOCKET, 20, os.dupterm_notify)
    os.dupterm(web_socket)
    return True


def stop():
    global listen_s, client_s
    os.dupterm(None)
    if client_s:
        client_s.close()
    if listen_s:
        listen_s.close()


def start(port=8266, password=None, accept_handler=accept_conn):
    global static_host
    stop()
    webrepl_password = password
    if webrepl_password is None:
        try:
            import webrepl_cfg

            webrepl_password = webrepl_cfg.PASS
            if hasattr(webrepl_cfg, "BASE"):
                static_host = webrepl_cfg.BASE
        except Exception:
            print("WebREPL is not configured, run 'import webrepl_setup'")

    _webrepl.password(webrepl_password)
    server = setup_conn(port, accept_handler)

    if accept_handler is None:
        print("Starting webrepl in foreground mode")
        while not accept_conn(server):
            pass
    elif password is None:
        print("Started webrepl in normal mode")
    else:
        print("Started webrepl in manual override mode")


def start_foreground(port=8266, password=None):
    start(port, password, None)

