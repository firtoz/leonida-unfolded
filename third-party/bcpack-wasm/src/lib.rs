use bcpack::bc1::{decode, QuadTable, Window};
use std::cell::RefCell;
use std::sync::OnceLock;

// The viewer reads only 1024² and 2048² single-level BC1 masks.
const MAX_BYTES: usize = 2048 * 2048 / 2;
static TABLES: OnceLock<(Window, QuadTable)> = OnceLock::new();

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn prepare_input(length: usize) -> *mut u8 {
    if length == 0 || length > MAX_BYTES + 1024 {
        return std::ptr::null_mut();
    }
    INPUT.with_borrow_mut(|input| {
        input.resize(length, 0);
        input.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn decode_bc1(expected: usize) -> *const u8 {
    if expected == 0 || expected > MAX_BYTES || expected % 8 != 0 {
        return std::ptr::null();
    }
    let (window, quads) = TABLES.get_or_init(|| (Window::default_table(), QuadTable::default_table()));
    let decoded = INPUT.with_borrow(|input| decode(input, expected / 8, window, quads));
    let Ok(decoded) = decoded else {
        return std::ptr::null();
    };
    if decoded.blocks.len() != expected || decoded.unfitted_blocks != 0 {
        return std::ptr::null();
    }
    OUTPUT.with_borrow_mut(|output| {
        *output = decoded.blocks;
        output.as_ptr()
    })
}
