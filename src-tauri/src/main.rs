// Release builds attach no console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    syncdrop_lib::run()
}
